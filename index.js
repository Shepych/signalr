import signalR from "@microsoft/signalr";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import logger from "./logger.js";
import { io } from "socket.io-client";
import axios from 'axios';

dotenv.config();

let db;
let connection;
let subscribedMatches = new Set()
const acl_ussr = 1022830; // 80676
const matchDay = 96184;
let scoutEvents = []

async function run() {
    await initDb();

    let accessToken = await integrationAuth();
    let events1X = await integrationEvents(accessToken);
    console.log(events1X)

    const authData = { token: accessToken };
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

            // Достаём ID матча скаутовского именно, а не 1x
            const [[game]] = await db.execute(
                "SELECT * FROM wp_joomsport_matches WHERE integration_game_id = ? LIMIT 1",
                [gameId]
            );


            if (sockets[game.postID]) {
                const test = [{
                    additionalTo: null,
                    assists: [],
                    e_id: eventConverter(eventId),
                    e_name: "TEST",
                    id: 38905880,
                    is_deleted: false,
                    minutes: "00:00",
                    player: "",
                    post_title: "TEST",
                    score: "1 - 1",
                    t_id: 373474,
                    timeevent: "13:53:11"
                }]
                const payload =
                    {
                        command: "add_event",
                        data: matchData.Data, // Сюда отправить форматированную дату
                        room: game.postID,
                        socket_id: socketMap[game.postID].socket_id, // можно сгенерировать случайный
                        is_scout: true
                    }
                const payloadTwo =
                    {
                        command: "insertRecord",
                        data: test, // Сюда отправить форматированную дату
                        room: game.postID,
                        socket_id: socketMap[game.postID].socket_id, // можно сгенерировать случайный
                        is_scout: true
                    }

                sockets[game.postID].emit("add_event", payload);
                sockets[game.postID].emit("insertRecord", payloadTwo);

                await addEvent(game.postID, eventId)
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

function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
async function createMatch(gameId) {

    const dateMatch = new Date().toISOString().split('T')[0];
    const timeMatch = "12:56:00";
    const timeSocrMatch = "12:56";
    const timeGmtMatch = "15:56:00";
    let teamHomeID = 123; // Передать сюда ID 1x матча
    let teamAwayID = 123;

    // Найти по метаполю в бд этот интеграционный ID если нету - создать

    await db.beginTransaction();

    try {
        let postResult = await db.execute(
            "INSERT INTO wp_posts (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [2, dateMatch + " " + timeMatch, dateMatch + " " + timeGmtMatch, "", "1x integration match: " + gameId, "", "publish", "closed", "closed", "", gameId + "_1x_integration", "", "", dateMatch + " " + timeMatch, dateMatch + " " + timeGmtMatch, "", 0, "http://scout.local/match/" + gameId + "_1x_integration", 0, "joomsport_team", "", 0]
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

async function createTeam() {
    // Указать все параметры для создания команды
    let teamStringId = generateRandomString(10);
    const dateTeam = new Date().toISOString().split('T')[0];
    const timeTeam = "12:56:00";
    const gmtTimeTeam = "15:56:00";
    const integrationID = 1111;

    let postTeam = await db.execute(
        "INSERT INTO wp_posts (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [2, dateTeam + " " + timeTeam, dateTeam + " " + gmtTimeTeam, "", "1x integration TEAM " + teamStringId, "", "publish", "closed", "closed", "", teamStringId + "_integration", "", "", dateTeam + " " + timeTeam, dateTeam + " " + gmtTimeTeam, "", 0, "http://scout.local/match/" + teamStringId + "_1x_integration", 0, "joomsport_team", "", 0]
    );
    let postID = postTeam[0].insertId;

    const metaValues = [
        [postID, '_edit_lock', '1747317607:2'],
        [postID, '_edit_last', 195],
        [postID, '_thumbnail_id', 0],
        [postID, '_wp_old_date', 0],
        [postID, 'vdw_gallery_id', ''],

        [postID, '_joomsport_team_personal', 'a:2:{s:10:"short_name";s:11:"Integration Team 1";s:11:"middle_name";s:11:"IntegrationTeam1";}'],
        [postID, '_joomsport_team_about', ''],
        [postID, '_joomsport_team_ef', 'a:5:{i:20;s:0:"";i:23;s:0:"";i:29;s:8:"IT1";i:32;s:11:"int_team_1";i:33;s:11:"IntegrationTeam1";}'],
        [postID, '_joomsport_team_venue', '0'],

        [postID, 'wpbf_options', 'a:1:{i:0;s:13:"layout-global";}'],
        [postID, 'wpbf_sidebar_position', 'global'],

        [postID, 'integration_team_id', integrationID],
    ];

    const query = `
            INSERT INTO wp_postmeta (post_id, meta_key, meta_value)
            VALUES (?, ?, ?)
        `;

    for (const row of metaValues) {
        await db.execute(query, row);
    }
    console.log('Команда создана');
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

async function addEvent(matchId, eventId) {
    const params = {
        action: 'add_event',
        match_id: matchId,
        post_title: 'Событие из SIGNAL_R',
        t_id: 0,
        e_name: 'Событие из SIGNAL_R',
        minutes: '00:00',
        stage: 0,
        e_id: eventConverter(eventId),
        player_number: null,
        left_time: '00:00',
        total_time: '00:00',
        season_id: acl_ussr,
        user_id: 2,
        frame: 0
    }
    console.log('matchID: ' + matchId)
    console.log('eventID: ' + eventId)

    try {
        const response = await axios.get('http://api.local/api/protocol/v3.0/index-dev2.php', { params });
        console.log(response.data);
    } catch (error) {
        console.error('Ошибка запроса:', error);
    }
}

run().catch((err) => logger.error(`Фатальная ошибка: ${err.message}`));

async function integrationAuth() {
    const response = await axios.post('https://partners.xsportzone.com/api/v1/account/auth', {
        Login: 'partmaxsport',
        Password: 'Mh23Ba28n'
    })

    if (response.data.CodeError === 0) {
        const accessToken = response.data.Data.Access_token;
        console.log('Access_token:', accessToken);
        return accessToken;
    }
}

async function integrationEvents(accessToken) {
    try {
        const [rows] = await db.execute(
            "SELECT * FROM wp_joomsport_events WHERE integration = true"
        );
        scoutEvents = rows;
        return rows;
    } catch (error) {
        console.error("Ошибка при выполнении запроса:", error);
        throw error;
    }

    // return await axios.get('https://partners.xsportzone.com/api/v1/references/eventtypes', {
    //     headers: {
    //         'Authorization': `Bearer ${accessToken}`
    //     }
    // }).then(response => {
    //     if (response.data.CodeError === 0) {
    //         console.log(response.data.Data)
    //         return response.data.Data;
    //     }
    // })
    // .catch(error => {
    //     console.error('Ошибка запроса:', error.message);
    // });

}

function eventConverter(eventId) {
    if (!scoutEvents) {
        throw new Error("События ещё не загружены. Сначала вызовите integrationEvents.");
    }

    console.log(scoutEvents);
    console.log('1xevent: ' + eventId);
    const found = scoutEvents.find(event => event.integration_id === eventId);
    console.log('fe_id: ' + found.id)
    return found ? found.id : null;
}
// Функционал получения игроков по ID из интеграции, если таких нет - создаём и привязываем к турниру
// Функция конвертации всех событий 1x в наши события
// Фукнционал создания игровых дней привязанных к нужным сезонам
// Отправка событий по сокету в нужном нам формате