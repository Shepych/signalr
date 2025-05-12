import signalR from "@microsoft/signalr";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import logger from "./logger.js";
import WebSocket from "ws";
import { io } from "socket.io-client";  // Установите пакет: npm install socket.io-client

dotenv.config();

let db;
let connection;
let subscribedMatches = new Set();
let socketId = null;

async function initDb() {
    db = await mysql.createConnection({
        host: process.env.DB_HOST || "MySQL-8.4",
        user: process.env.DB_USER || "root",
        password: process.env.DB_PASSWORD || "",
        database: process.env.DB_NAME || "signalr",
    });
}

async function connectClient(authData) {
    connection = new signalR.HubConnectionBuilder()
        .withUrl(process.env.SIGNALR_URL, {
            accessTokenFactory: () => authData.token,
        })
        .withAutomaticReconnect()
        .configureLogging(signalR.LogLevel.Information)
        .build();

    try {
        await connection.start();
        logger.info("SignalR подключение установлено");
        return { success: true };
    } catch (err) {
        logger.error(`Ошибка подключения к SignalR: ${err.message}`);
        return { success: false, error: err };
    }
}

async function getAllEvents() {
    try {
        const [rows] = await db.execute("SELECT * FROM events");
        rows.forEach((row) => {
            logger.info(`ID: ${row.id}, GameID: ${row.match_id}, EventId: ${row.event_id}`);
        });
    } catch (err) {
        logger.error(`Ошибка при получении данных из events: ${err.message}`);
    }
}

async function subscribeListMatches() {
    if (!connection) throw new Error("Сначала подключите клиента");
    return await connection.invoke("SubscribeListMatches");
}

async function subscribeMatch(gameId) {
    if (!connection) throw new Error("Сначала подключите клиента");
    try {
        const res = await connection.invoke("SubscribeMatch", gameId);
        return res;
    } catch (err) {
        logger.error(`Ошибка подписки: ${err.message}`);
        return { success: false, error: err };
    }
}

async function unsubscribeMatch(gameId) {
    if (!connection) throw new Error("Сначала подключите клиента");
    try {
        await connection.invoke("UnsubscribeMatch", gameId);
        connection.off("ReceiveMatchUpdate");
        logger.info(`Отписка от игры ${gameId} выполнена`);
        console.log(subscribedMatches)
        return { success: true };
    } catch (err) {
        logger.error(`Ошибка отписки: ${err.message}`);
        return { success: false, error: err };
    }
}

function formatDateForMySQL(dateString) {
    const date = new Date(dateString);
    return date.toISOString().slice(0, 19).replace("T", " ");
}

async function subscribeToLiveMatches(matches) {
    console.log(matches)
    for (const matchId of matches) {
        if (!subscribedMatches.has(matchId)) {
            await subscribeMatch(matchId);
            subscribedMatches.add(matchId);
            logger.info(`Подписка на матч ${matchId}`);
        }
    }
}

async function refreshAndSubscribeFilteredMatches() {
    try {
        const updatedList = await subscribeListMatches();

        const filteredMatches = updatedList.Data.filter(match =>
            match?.Title?.includes("ACL") || match?.Title?.includes("USSR")
        );

        const filteredIds = filteredMatches.map(m => m.Id);
        await subscribeToLiveMatches(filteredIds);
    } catch (err) {
        logger.error(`Ошибка при обновлении списка матчей: ${err.message}`);
    }
}

async function reSubscribeToMatches() {
    await subscribeToLiveMatches([...subscribedMatches]);
}

async function run() {
    let socket = connectWebSocket();

    await initDb();

    const authData = { token: "123" };
    const connectResult = await connectClient(authData);
    if (!connectResult.success) return;

    let listMatches = await subscribeListMatches();
    console.log(listMatches)
    let filteredMatches = listMatches.Data.filter(match =>
        match?.Title?.includes("ACL") || match?.Title?.includes("USSR")
    );
    const filteredIds = filteredMatches.map(m => m.Id);
    const liveMatches = [];
    await subscribeToLiveMatches([...liveMatches, ...filteredIds]);

    connection.on("event", async (gameId, matchData) => {
        try {
            const eventId = matchData.Data.Type;
            const dateTimeEvent = formatDateForMySQL(matchData.Data.Date);
            const matchDataJson = JSON.stringify(matchData);

            await db.execute(
                "INSERT INTO events (match_id, event_id, json, date_time) VALUES (?, ?, ?, ?)",
                [gameId, eventId, matchDataJson, dateTimeEvent]
            );

            if (socket) {
                const payload =
                    {
                        command: "add_event",
                        data: matchData.Data,
                        room: 899761,
                        socket_id: socketId, // можно сгенерировать случайный
                        is_scout: true
                    }
                socket.emit("add_event", payload);
            }
            console.log("EVENT ADD")
        } catch (err) {
            logger.error(`Ошибка сохранения события в MySQL: ${err.message}`);
        }
    });

    connection.on("updateMatch", async (gameId, matchData) => {
        if (!subscribedMatches.has(gameId)) return;
        console.log(matchData)
    });

    connection.on("addMatch", async (gameId) => {
        logger.info(`Новый матч добавлен: ${gameId}`);

        try {
            // Обновляем список матчей
            const updatedList = await subscribeListMatches();

            const filteredMatches = updatedList.Data.filter(match =>
                match?.Title?.includes("ACL") || match?.Title?.includes("USSR")
            );

            const filteredIds = filteredMatches.map(m => m.Id);

            // Подписываемся только на новые, которые ещё не в списке
            for (const matchId of filteredIds) {
                if (!subscribedMatches.has(matchId)) {
                    await subscribeMatch(matchId);
                    subscribedMatches.add(matchId);
                    logger.info(`Автоподписка на матч ${matchId} после addMatch`);
                    console.log(subscribedMatches)
                }
            }
        } catch (err) {
            logger.error(`Ошибка в обработчике addMatch: ${err.message}`);
        }
    });

    connection.on("removeMatch", async (gameId, matchData) => {
        if (!subscribedMatches.has(gameId)) return;
        console.log('ОТПИСКА')
        logger.info(`Матч ${gameId} завершён, отписываемся...`);
        await unsubscribeMatch(gameId);
        subscribedMatches.delete(gameId);
        await refreshAndSubscribeFilteredMatches();
        console.log(subscribedMatches)
    });

    connection.onreconnected(async (connectionId) => {
        logger.warn(`Повторное подключение к SignalR: ${connectionId}`);
        process.exit(1);
    });

    connection.onclose(async (error) => {
        logger.error(`SignalR соединение закрыто: ${error?.message || "без ошибки"}`);

        let attempts = 0;
        const maxAttempts = 10;

        while (attempts < maxAttempts) {
            try {
                attempts++;
                logger.info(`Попытка переподключения #${attempts}...`);
                await connection.start();
                logger.info("SignalR переподключение успешно");
                await reSubscribeToMatches();
                break;
            } catch (err) {
                logger.error(`Ошибка переподключения: ${err.message}`);
                await new Promise(res => setTimeout(res, 5000));
            }
        }

        if (attempts === maxAttempts) {
            logger.error("Все попытки переподключения исчерпаны. Перезапуск приложения...");
            setTimeout(() => process.exit(1), 5000);
        }
    });
}

// SCOUT соет

let wsClient;

function connectWebSocket() {
    const socket = io("ws://localhost:5555", {  // Замените на ваш URL
        transports: ['websocket', 'polling'],
        closeOnBeforeunload: false,
    });

    socket.emit('connecting_to_match', { match_id: 899761, api_key: "089ca38fa9b741db9ea4a66f3e71ed64", isScout: true}, () => {})

    socket.on('scout_authentication', (data) => {
        socketId = data.socket_id;
        console.log('scout_authentication') // При подключении сюда прилетает Socket ID
    })

    return socket;  // Чтобы можно было использовать снаружи
}

run().catch((err) => logger.error(`Фатальная ошибка: ${err.message}`));