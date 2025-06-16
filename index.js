import signalR from "@microsoft/signalr";
import dotenv from "dotenv";
import mysql from "mysql2/promise";
import logger from "./logger.js";
import { io } from "socket.io-client";
import axios from 'axios';
import net from 'net';

// Отправка в расписание (на паузе)
const client = net.createConnection({ port: 1234, host: '127.0.0.1' }, () => {
    console.log('Connected to PHP socket');
    const message = {
        divisionID: 80676,
        match_date: "2025-06-16",
        message: {
            type: "ADD_MATCH",
            data: {
                division: { id: 80676 },
                season: { id: 1022830 },
                match: {
                    id: 456,
                    datetime: "2025-06-16 15:30",
                    link: "https://example.com",
                    mdName: "Матч дня"
                },
                home: {
                    name: {
                        ru: 'RU AWAY',
                        en: 'EN AWAY',
                    },
                    score: 0,
                    id: 373474
                },
                away: {
                    name: {
                        ru: 'RU AWAY',
                        en: 'EN AWAY',
                    },
                    score: 0,
                    id: 373475
                }
            }
        }
    };

    client.write(JSON.stringify(message) + '\n');
    client.end();
});

client.on('error', (err) => {
    console.error('Ошибка:', err.message);
});

// КОНЕЦ ОТПРАВКИ НА РАСПИСАНИЕ

dotenv.config();

let db;
let connection;
let subscribedMatches = new Set()
const acl_ussr = 1022830; // это season_id, а его division_id - 80676
const matchDay = 96184;
let scoutEvents = []
let accessToken = null;

const operatorTours = {
    1141: [
        'Space division M1',
        'Space division M2',
        'Space division M3',
        'Space division M4',
        'Space division M5',

        'Space Division GRL',
        'Space Division GRL 2',
        'Space Division GRL 3',
    ],
    1340: [
        'Space division M1',
        'Space division M2',
        'Space division M3',
        'Space division M4',
        'Space division M5',

        'Space Division GRL',
        'Space Division GRL 2',
        'Space Division GRL 3',
    ],
    1432: [
        'Pro Division A',
        'Pro Division B',
        'Pro Division C',
        'Pro Division G',
        'Pro Division В', // ?
    ],
    1548: [
        'Pro Division H',
        'Pro Division F',
        'Pro Division J',
        'Pro Division K',
    ],
    1433: [
        'Pro Division Woman'
    ],
    1442: [
        'Prime Division A',
        'Prime Division B',
        'Prime Division C',
    ],
    1527: [
        'Prime Division Woman A',
        'Prime Division Woman B',
        'Prime Division Woman C',
    ]
}

const sockets = [];
const socketMap = {};

async function run() {
    await initDb();

    accessToken = await integrationAuth();

    // let integrationMatchesFromAPI = await getIntegrationMatches(accessToken)
    let events1X = await integrationEvents(accessToken);
    // console.log(integrationMatchesFromAPI)
    // return;

    const authData = { token: accessToken };
    const connectResult = await connectClient(authData);
    if (!connectResult.success) return;

    let listMatches = await subscribeListMatches();
    let filteredMatches = listMatches.Data.filter(match =>
        match?.Title?.includes("PRO") // Написать функцию для распределения нужных туриков
    );
    const filteredIds = filteredMatches.map(m => m.Id);


    for (const integrationMatchID of filteredIds) {
        const [[game]] = await db.execute(
            "SELECT * FROM wp_joomsport_matches WHERE integration_game_id = ? LIMIT 1",
            [integrationMatchID]
        );
        let postID = null;
        if (!game) {
            postID = await createMatch(integrationMatchID, filteredMatches)
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
            // const matchDataJson = JSON.stringify(matchData);

            // await db.execute(
            //     "INSERT INTO events (match_id, event_id, json, date_time) VALUES (?, ?, ?, ?)",
            //     [gameId, eventId, matchDataJson, dateTimeEvent]
            // );

            console.log('1x event json:')
            console.log(matchData.Data)
            // Достать отсюда Time и Team


            // отправить запрос на index-dev2 чтобы кэши создались, обновились и тд и в базу добавилось
            // Сформировать нужную структуру объекта для отправки в сокет

            // Достаём ID матча скаутовского именно, а не 1x
            const [[game]] = await db.execute(
                "SELECT * FROM wp_joomsport_matches WHERE integration_game_id = ? LIMIT 1",
                [gameId]
            );


            if (sockets[game.postID]) {
                // const test = [{
                //     additionalTo: null,
                //     assists: [],
                //     e_id: eventConverter(eventId),
                //     e_name: "TEST", // Вытащить название события
                //     id: 38905880, // Сюда передать ID добавленного события
                //     is_deleted: false,
                //     minutes: formatTime(matchData.Data.Time),
                //     player: "",
                //     post_title: "TEST",
                //     score: matchData.Data.ScoreInfo.ScoreFull.Score1 + " - " + matchData.Data.ScoreInfo.ScoreFull.Score2,
                //     t_id: 373474, // Привязать ID команды из скаута
                //     timeevent: getCurrentTime()
                // }]
                //
                // const payload =
                //     {
                //         command: "add_event",
                //         // data: matchData.Data, // Сюда отправить форматированную дату
                //         data: test, // Сюда отправить форматированную дату
                //         room: game.postID,
                //         socket_id: socketMap[game.postID].socket_id, // можно сгенерировать случайный
                //         is_scout: true
                //     }
                // const payloadTwo =
                //     {
                //         command: "insertRecord",
                //         data: test, // Сюда отправить форматированную дату
                //         room: game.postID,
                //         socket_id: socketMap[game.postID].socket_id, // можно сгенерировать случайный
                //         is_scout: true
                //     }
                //
                // sockets[game.postID].emit("add_event", payload);
                // sockets[game.postID].emit("insertRecord", payloadTwo);

                await addEvent(game.postID, eventId, matchData.Data)
                console.log("EVENT ADD FOR SCOUT GAME: " + game.postID)
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
                match?.Title?.includes("PRO")
            );

            const filteredIds = filteredMatches.map(m => m.Id);

            // Подписываемся только на новые, которые ещё не в списке
            for (const matchId of filteredIds) {
                if (!subscribedMatches.has(matchId)) {
                    await subscribeMatch(matchId);
                    subscribedMatches.add(matchId);
                    logger.info(`Автоподписка на матч ${matchId} после addMatch`);
                    // console.log(subscribedMatches)

                    let [existing] = await db.execute(
                        "SELECT 1 FROM wp_joomsport_matches WHERE integration_game_id = ? LIMIT 1",
                        [gameId]
                    );

                    // Добавить привязку к нужным дивизионам

                    if (existing.length === 0) {
                        let postID = await createMatch(gameId, filteredMatches);

                        let socket = connectWebSocket(gameId, postID);

                        sockets[postID] = socket;
                        socketMap[postID] = {socket, socket_id: null, gameId};

                        socket.on('scout_authentication', (data) => {
                            socketMap[postID].socket_id = data.socket_id;
                            console.log(`Socket authenticated for match ${gameId} (postID: ${postID}): ${data.socket_id}`);
                        });
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
        // Отправляем запрос на API чтоб статус 1 в wp_postmeta поставить и wp_joomsport_matches
        // console.log(scoutMatchID)
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
            match?.Title?.includes("PRO")
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
async function createMatch(gameId, ourMatches, xTeamHomeID = 373475, xTeamAwayID = 373474) {
    const dateMatch = new Date().toISOString().split('T')[0];
    const timeMatch = getCurrentTime();
    const timeSocrMatch = getCurrentTime('HH:mm', 3);
    const timeGmtMatch = getCurrentTime('HH:mm', 6);

    console.log('filtredNew: ')
    console.log(ourMatches)

    let matchInfo // Здесь оператор ID лежит и ID команд
    const integrationMatches = await getIntegrationMatches(accessToken)

    for (const match of integrationMatches) {
        if(match.Id === gameId) matchInfo = match
    }

    let teamHomeID = await createTeam(matchInfo.Team1, matchInfo.Config.ColorTeam1);
    let teamAwayID = await createTeam(matchInfo.Team2, matchInfo.Config.ColorTeam2);

    console.log('Team1:')
    console.log(teamHomeID)

    console.log('Team2:')
    console.log(teamAwayID)

    // Найти айдишник нашего матча в ourMatches
    // Достать id оператора из списка
    // Сделать запрос на получение оператора
    // Получить ID команд и сделать запрос по этим интеграционным ID (integration_team_id) в нашей базе
    // Если они не найдены - то создаём, НО там может быть 0, если 0 - тогда ищем по названию (integration_team_name)
    // Нашли или создали - и достаём этот POST ID, Team1 подставляем в teamHome, Team2 подставляем в teamAway для матча


    await db.beginTransaction();

    try {
        let postResult = await db.execute(
            "INSERT INTO wp_posts (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [2, dateMatch + " " + timeMatch, dateMatch + " " + timeGmtMatch, "", "1x integration match: " + gameId, "", "publish", "closed", "closed", "", gameId + "_1x_integration", "", "", dateMatch + " " + timeMatch, dateMatch + " " + timeGmtMatch, "", 0, "http://scout.local/match/" + gameId + "_1x_integration", 0, "joomsport_team", "", 0]
        );
        let postID = postResult[0].insertId;
        await db.execute(
            "INSERT INTO wp_joomsport_matches (postID, mdID, seasonID, teamHomeID, teamAwayID, groupID, status, date, time, scoreHome, scoreAway, post_status, duration, created_at, integration, integration_game_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [postID, matchDay, acl_ussr, teamHomeID, teamAwayID, 0, 0, dateMatch, timeSocrMatch, "0.00", "0.00", "publish", 0, dateMatch + " " + timeMatch, true, gameId]
        );

        const metaValues = [
            [postID, '_joomsport_home_team', teamHomeID],
            [postID, '_joomsport_away_team', teamAwayID],
            [postID, '_joomsport_home_score', '0'],
            [postID, '_joomsport_away_score', '0'],
            [postID, '_joomsport_groupID', '0'],
            [postID, '_joomsport_seasonid', acl_ussr],
            [postID, '_joomsport_match_played', '-1'],
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

        // Отправить запрос на создание matchinfo (вначале создать апи)
        // И там же создаём кэш матча

        axios.get(process.env.SCOUT_URL + '/api/integration/make_cache_files.php?match_id=' + postID + '&key=' + process.env.USER_KEYS_ACCESS_TOKEN)
            .then(response => {
                console.log('Matchinfo создан:', response.data);
            })
            .catch(error => {
                console.error('Ошибка создания Matchinfo:', error.message);
            });

        // Создание кэшей
        const url = process.env.SCOUT_URL + '/api/protocol/v3.0/index.php';
        const params = {
            action: 'make_cache_match',
            score_string: '0-0',
            away_score: 0,
            home_score: 0,
            match_time_start: '14:00',
            match_end: '15:00',
            home_team_name: 'Team1',
            away_team_name: 'Team2',
            status: 0,
            division_id: 80676,
            match_id: postID,
            stage: 1,
            type_of_sport: 'bb'
        };

        axios.get(url, { params })
            .then(response => {
                console.log('Кэш создан:', response.data);
            })
            .catch(error => {
                console.error('Ошибка создания кэша:', error.message);
            });

        return postID
    } catch (err) {
        await db.rollback();
        console.error('Ошибка при добавлении мета-данных:', err);
    }
    return false;
}

async function updateCache(matchId, eventData) {
    // Делаем запрос на matchinfo кэш, парсим и подставляем в update_cache

    const cacheUrl = process.env.SCOUT_URL + '/matchinfo/' + matchId + '.json'; // укажи свой URL

    axios.get(cacheUrl)
        .then(response => {
            const data = response.data;

            const dateTimeStr = data.datatime; // "13.06.2025 13:54"

            const [datePart, timePart] = dateTimeStr.split(' '); // ["13.06.2025", "13:54"]
            const [day, month, year] = datePart.split('.'); // ["13", "06", "2025"]

            const formattedDate = `${year}-${month}-${day}`; // "2025-06-13"
            const formattedTime = timePart; // "13:54"

            // Создание кэшей
            const url = process.env.SCOUT_URL + '/api/protocol/v3.0/index.php';
            const params = {
                action: 'update_cache',
                data: {
                    score_string: eventData.ScoreInfo.ScoreFull.Score1 + '-' + eventData.ScoreInfo.ScoreFull.Score1,
                    away_score: eventData.ScoreInfo.ScoreFull.Score2,
                    home_score: eventData.ScoreInfo.ScoreFull.Score1,
                    match_time_start: formattedTime,
                    match_end: '15:00',
                    home_team_name: data.home, // либо убрать полностью, либо вытягивать из matchinfo
                    away_team_name: data.away,
                    matchDate: data.datatime, // Прокинуть дату текущего матча
                    status: eventConverter(eventData.Type) !== 193 ? -1 : 1,
                    division_id: 80676,
                    date: formattedDate, // Прокинуть дату текущего матча
                    match_id: matchId,
                    stage: 1,
                    type_of_sport: 'bb'
                }
            };

            axios.post(url, params)
                .then(response => {
                    console.log('updateCache:');
                    console.log(response.data);
                })
                .catch(error => {
                    console.error('updateCache error:', error.message);
                });

        })
        .catch(error => {
            console.error('Ошибка при получении JSON:', error.message);
    });






}
async function createTeam(teamInfo, colorHex) {
    const integrationID = teamInfo.Id;
    const integrationTeamName = teamInfo.Name;
    // Поиск по integration_team_id

    const [findTeamInScout] = await db.execute(
        "SELECT * FROM `wp_postmeta` WHERE `meta_key` = 'integration_team_id' AND `meta_value` = " + integrationID
    );

    let teamScout = findTeamInScout[0];

    if(integrationID === 0) { // Если у иксов не проставел ID команды
        teamScout = false;
    }

    if (!teamScout) {
        // Если ничего не найдено — ищем по integration_team_name
        const [findByName] = await db.execute(
            "SELECT * FROM `wp_postmeta` WHERE `meta_key` = 'integration_team_name' AND `meta_value` = '" + integrationTeamName + "'"
        );
        teamScout = findByName[0];
        console.log(teamScout)
    }

    let postID = null;

    if(teamScout) {
        console.log('TUT2')
        // Возвращаем существующую команду
        return teamScout.post_id
    } else {
        console.log('TUT3')
        // Создаём новую команду
        let teamStringId = generateRandomString(10);
        const dateTeam = new Date().toISOString().split('T')[0];
        const timeTeam = "12:56:00";
        const gmtTimeTeam = "15:56:00";

        const MAX_ATTEMPTS = 3;
        let attempt = 0;
        let success = false;

        while (attempt < MAX_ATTEMPTS && !success) {
            attempt++;
            try {
                await db.beginTransaction();

                // Вставка в wp_posts
                let postTeam = await db.execute(
                    "INSERT INTO wp_posts (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt, post_status, comment_status, ping_status, post_password, post_name, to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered, post_parent, guid, menu_order, post_type, post_mime_type, comment_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [2, dateTeam + " " + timeTeam, dateTeam + " " + gmtTimeTeam, "", integrationTeamName, "", "publish", "closed", "closed", "", teamStringId + "_integration", "", "", dateTeam + " " + timeTeam, dateTeam + " " + gmtTimeTeam, "", 0, "http://scout.local/match/" + teamStringId + "_1x_integration", 0, "joomsport_team", "", 0]
                );

                postID = postTeam[0].insertId;
                const lengthTeamName = new TextEncoder().encode(integrationTeamName).length; // Длинна строки для SERIALIZE php
                const lengthColorHex = new TextEncoder().encode(colorHex).length; // Длинна строки для SERIALIZE php

                // Формирование metaValues
                const metaValues = [
                    [postID, '_edit_lock', '1747317607:2'],
                    [postID, '_edit_last', 195],
                    [postID, '_thumbnail_id', 0],
                    [postID, '_wp_old_date', 0],
                    [postID, 'vdw_gallery_id', ''],

                    [postID, '_joomsport_team_personal', 'a:2:{s:10:"short_name";s:11:"Integration Team 1";s:11:"middle_name";s:11:"IntegrationTeam1";}'],
                    [postID, '_joomsport_team_about', ''],
                    [postID, '_joomsport_team_ef', 'a:5:{i:20;s:' + lengthColorHex + ':"' + colorHex +'";i:23;s:0:"";i:29;s:0:"";i:32;s:' + lengthTeamName + ':"' + integrationTeamName + '";i:33;s:' + lengthTeamName + ':"' + integrationTeamName + '";}'],
                    [postID, '_joomsport_team_venue', '0'],

                    [postID, 'wpbf_options', 'a:1:{i:0;s:13:"layout-global";}'],
                    [postID, 'wpbf_sidebar_position', 'global'],

                    [postID, 'integration_team_id', integrationID],
                    [postID, 'integration_team_name', integrationTeamName],
                ];

                const query = `
                    INSERT INTO wp_postmeta (post_id, meta_key, meta_value)
                    VALUES (?, ?, ?)
                `;

                for (const row of metaValues) {
                    await db.execute(query, row);
                }

                await db.commit();
                success = true;
            } catch (err) {
                await db.rollback();
                if (attempt >= MAX_ATTEMPTS) {
                    throw new Error("Не удалось выполнить транзакцию после нескольких попыток: " + err.message);
                }
            }
        }

        return postID;
    }
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

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getCurrentTime(format = 'HH:mm:ss', gmtOffset = 3) {
    const now = new Date();

    // Получаем текущее UTC время
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const utcSeconds = now.getUTCSeconds();

    // Применяем смещение GMT
    const hours = String((utcHours + gmtOffset + 24) % 24).padStart(2, '0');
    const minutes = String(utcMinutes).padStart(2, '0');
    const seconds = String(utcSeconds).padStart(2, '0');

    return format
        .replace('HH', hours)
        .replace('mm', minutes)
        .replace('ss', seconds);
}

async function addEvent(matchId, eventId, eventData) {
    const cacheUrl = process.env.SCOUT_URL + '/matchinfo/' + matchId + '.json'; // укажи свой URL

    let homeId = null;
    let awayId = null;

    try {
        const response = await axios.get(cacheUrl);
        const data = response.data;

        homeId = data.home_id;
        awayId = data.away_id;
    } catch (error) {
        console.error('Ошибка получения данных матча:', error);
        return;
    }

    const t_id = eventData.Team === 1 ? homeId : awayId;

    const params = {
        action: 'add_event',
        match_id: matchId,
        post_title: 'Событие из SIGNAL_R',
        t_id: t_id,
        e_name: 'Событие из SIGNAL_R',
        minutes: formatTime(eventData.Time),
        stage: 0,
        e_id: eventConverter(eventId),
        player_number: null,
        left_time: formatTime(eventData.Time),
        total_time: formatTime(eventData.Time),
        season_id: acl_ussr,
        user_id: 2, // ID админа
        frame: 0,
        event_score_home: eventData.ScoreInfo.ScoreFull.Score1,
        event_score_away: eventData.ScoreInfo.ScoreFull.Score2,
    };

    console.log('matchID: ' + matchId);
    console.log('eventID: ' + eventId);

    // Обновление кэша если голы
    await updateCache(matchId, eventData);

    try {
        const response = await axios.get(process.env.API_URL + '/api/protocol/v3.0/index-dev2.php', { params });
        console.log(response.data);
    } catch (error) {
        console.error('Ошибка запроса:', error);
    }

    // Отправка на сокет
    const test = [{
        additionalTo: null,
        assists: [],
        e_id: eventConverter(eventId),
        e_name: "TEST", // Вытащить название события
        id: 38905880, // Сюда передать ID добавленного события
        is_deleted: false,
        minutes: formatTime(eventData.Time),
        player: "",
        post_title: "TEST",
        // score: eventData.ScoreInfo.ScoreFull.Score1 + " - " + eventData.ScoreInfo.ScoreFull.Score2,
        t_id: t_id,
        timeevent: getCurrentTime(),
        event_score_home: eventData.ScoreInfo.ScoreFull.Score1,
        event_score_away: eventData.ScoreInfo.ScoreFull.Score2,
    }]

    const payload =
        {
            command: "add_event",
            // data: matchData.Data, // Сюда отправить форматированную дату
            data: test, // Сюда отправить форматированную дату
            room: matchId,
            socket_id: socketMap[matchId].socket_id, // можно сгенерировать случайный
            is_scout: true
        }
    const payloadTwo =
        {
            command: "insertRecord",
            data: test, // Сюда отправить форматированную дату
            room: matchId,
            socket_id: socketMap[matchId].socket_id, // можно сгенерировать случайный
            is_scout: true
        }

    sockets[matchId].emit("add_event", payload);
    sockets[matchId].emit("insertRecord", payloadTwo);
}

function protocolLogic() {
    // Нужно учитывать ещё событие которое отменяет последнее событие
    console.log('Здесь перебираем массив с событиями')
    // Обрабатываем массив с событиями, и отправляем необходимые данные по сокету и в API
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

async function getIntegrationMatches(accessToken) {
    return await axios.get('https://partners.xsportzone.com/api/v1/games', {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    }).then(response => {
        if (response.data.CodeError === 0) {
            console.log(response.data.Data)
            return response.data.Data;
        }
    })
}

function eventConverter(eventId) {
    if (!scoutEvents) {
        throw new Error("События ещё не загружены. Сначала вызовите integrationEvents.");
    }

    // console.log(scoutEvents);
    console.log('1xevent: ' + eventId);
    const found = scoutEvents.find(event => event.integration_id === eventId);
    console.log('fe_id: ' + found.id)
    return found ? found.id : null;
}
