import signalR from "@microsoft/signalr";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import logger from "./logger.js";
import { io } from "socket.io-client";

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
    return await connection.invoke("SubscribeListMatches" );
}

async function subscribeMatch(gameId) {
    if (!connection) throw new Error("Сначала подключите клиента");

    try {
        return await connection.invoke("SubscribeMatch", gameId);
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
    await initDb();

    const authData = { token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1lIjoicGFydG1heHNwb3J0IiwiaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS93cy8yMDA4LzA2L2lkZW50aXR5L2NsYWltcy9yb2xlIjoiNyIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWVpZGVudGlmaWVyIjoiMTU4OCIsIm5iZiI6MTc0NzMwMDQxNywiZXhwIjoxNzQ3OTA1MjE3LCJpc3MiOiJTcG9ydFdvcmtCZW5jaCIsImF1ZCI6IkNsaWVudCJ9.S74aIeAG3pdnxkpSAB_kpCG52-URhVx4beLVEy_9Cpk" };
    const connectResult = await connectClient(authData);
    if (!connectResult.success) return;

    let listMatches = await subscribeListMatches();
    let filteredMatches = listMatches.Data.filter(match =>
        match?.Title?.includes("ACL") || match?.Title?.includes("USSR")
    );
    const filteredIds = filteredMatches.map(m => m.Id);

    const sockets = [];
    const socketMap = {};
    for (const integrationMatchID of filteredIds) {
        const [[game]] = await db.execute(
            "SELECT * FROM wp_joomsport_matches WHERE integration_game_id = ? LIMIT 1",
            [integrationMatchID]
        );
        let postID = null;
        if (!game) {
            postID = await createMatch(integrationMatchID)
        } else {
            postID = game.postID;
        }

        const socket = connectWebSocket(integrationMatchID, postID);

        sockets[postID] = socket;
        socketMap[postID] = {socket, socket_id: null, integrationMatchID};

        socket.on('scout_authentication', (data) => {
            socketMap[postID].socket_id = data.socket_id;
            console.log(`Socket authenticated for match ${integrationMatchID} (postID: ${postID}): ${data.socket_id}`);
        });
    }

    const liveMatches = [];
    await subscribeToLiveMatches([...liveMatches, ...filteredIds]);

    connection.on("event", async (gameId, matchData) => {
        try {
            const eventId = matchData.Data.Type;
            const dateTimeEvent = formatDateForMySQL(matchData.Data.Date);
            const matchDataJson = JSON.stringify(matchData);

            // await db.execute(
            //     "INSERT INTO events (match_id, event_id, json, date_time) VALUES (?, ?, ?, ?)",
            //     [gameId, eventId, matchDataJson, dateTimeEvent]
            // );




            // отправить запрос на index-dev2 чтобы кэши создались, обновились и тд и в базу добавилось
            // Сформировать нужную структуру объекта для отправки в сокет

            const [[game]] = await db.execute(
                "SELECT * FROM wp_joomsport_matches WHERE integration_game_id = ? LIMIT 1",
                [gameId]
            );

            if (sockets[game.postID]) {
                const payload =
                    {
                        command: "add_event",
                        data: matchData.Data,
                        room: game.postID,
                        socket_id: socketMap[game.postID].socket_id, // можно сгенерировать случайный
                        is_scout: true
                    }
                sockets[game.postID].emit("add_event", payload);

                console.log("EVENT ADD " + game.postID)
            } else {
                console.log("EVENT NOT ADD " + game.postID)
            }

        } catch (err) {
            logger.error(`Ошибка сохранения события в MySQL: ${err.message}`);
        }
    });

    connection.on("updateMatch", async (gameId, matchData) => {
        console.log(matchData)
        if (!subscribedMatches.has(gameId)) return;
        console.log(matchData)
    });

    connection.on("addMatch", async (gameId) => {
        // Создать матч в таблице
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


                    let [existing] = await db.execute(
                        "SELECT 1 FROM wp_joomsport_matches WHERE integration_game_id = ? LIMIT 1",
                        [gameId]
                    );

                    // Добавить привязку к нужным дивизионам

                    if (existing.length === 0) {
                        let postID = await createMatch(gameId);

                        let socket = connectWebSocket(gameId, postID);

                        sockets[postID] = socket;
                        socketMap[postID] = {socket, socket_id: null, gameId};

                        socket.on('scout_authentication', (data) => {
                            socketMap[postID].socket_id = data.socket_id;
                            console.log(`Socket authenticated for match ${gameId} (postID: ${postID}): ${data.socket_id}`);
                        });
                        console.log("Условие отработало")
                        console.log(sockets[postID])
                    }
                }
            }
        } catch (err) {
            logger.error(`Ошибка в обработчике addMatch: ${err.message}`);
        }
    });

    connection.on("removeMatch", async (gameId, matchData) => {
        if (!subscribedMatches.has(gameId)) return;

        let scoutMatchID = await getScoutMatch(gameId)
        console.log('ОТПИСКА')
        console.log(scoutMatchID)
        sockets[scoutMatchID].disconnect();
        delete sockets[scoutMatchID];
        delete socketMap[scoutMatchID];

        // Здесь отключаемся от сокета
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

async function createMatch(gameId) {
    const acl_ussr = 1022830; // 80676
    const matchDay = 96184;
    const dateMatch = new Date().toISOString().split('T')[0];
    const timeMatch = "12:56:00";
    const timeSocrMatch = "12:56";
    const timeGmtMatch = "15:56:00";

    await db.beginTransaction();

    try {
        let postResult = await db.execute(
            "INSERT INTO wp_posts (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [2, dateMatch + " " + timeMatch, dateMatch + " " + timeGmtMatch, "", "1x integration match: " + gameId, "", "publish", "closed", "closed", "", gameId + "_1x_integration", "", "", dateMatch + " " + timeMatch, dateMatch + " " + timeGmtMatch, "", 0, "http://scout.local/match/" + gameId + "_1x_integration", 0, "joomsport_match", "", 0]
        );
        let postID = postResult[0].insertId;
        await db.execute(
            "INSERT INTO wp_joomsport_matches (postID, mdID, seasonID, teamHomeID, teamAwayID, groupID, status, date, time, scoreHome, scoreAway, post_status, duration, created_at, integration, integration_game_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [postID, matchDay, acl_ussr, 373475, 373474, 0, 0, dateMatch, timeSocrMatch, "0.00", "0.00", "publish", 0, dateMatch + " " + timeMatch, true, gameId]
        );

        const metaValues = [
            [postID, '_joomsport_home_team', 373475],
            [postID, '_joomsport_away_team', 373474],
            [postID, '_joomsport_home_score', '0'],
            [postID, '_joomsport_away_score', '0'],
            [postID, '_joomsport_groupID', '0'],
            [postID, '_joomsport_seasonid', acl_ussr],
            [postID, '_joomsport_match_played', '0'],
            [postID, '_joomsport_match_date', dateMatch],
            [postID, '_joomsport_match_time', timeSocrMatch],
            [postID, '_joomsport_match_ef', 'a:3:{i:16;s:0:"";i:19;s:0:"";i:22;s:0:"";}'],
            [postID, '_edit_lock', '1747317607:2'],
        ];

        const query = `
            INSERT INTO wp_postmeta (post_id, meta_key, meta_value)
            VALUES (?, ?, ?)
        `;

        for (const row of metaValues) {
            await db.execute(query, row);
        }

        await db.execute(
            "INSERT INTO wp_term_relationships (object_id, term_taxonomy_id, term_order) VALUES (?, ?, ?)",
            [postID,matchDay,0]
        );

        await db.commit();
        console.log('Матч успешно добавлен в базу');
        return postID
    } catch (err) {
        await db.rollback();
        console.error('Ошибка при добавлении мета-данных:', err);
    }
    return false;
}

// SCOUT сокет
function connectWebSocket(integrationMatchID, postID) {
    const socket = io(process.env.SCOUT_SOCKET, {
        transports: ['websocket', 'polling'],
        closeOnBeforeunload: false,
    });

    socket.emit('connecting_to_match', {
        match_id: postID,
        api_key: "089ca38fa9b741db9ea4a66f3e71ed64",
        isScout: true
    });

    return socket;
}

async function getScoutMatch(integrationMatchID) {
    const [[game]] = await db.execute(
        "SELECT * FROM wp_joomsport_matches WHERE integration_game_id = ? LIMIT 1",
        [integrationMatchID]
    );
    return game.postID;
}

run().catch((err) => logger.error(`Фатальная ошибка: ${err.message}`));