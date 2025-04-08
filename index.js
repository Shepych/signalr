import signalR from "@microsoft/signalr";
import dotenv from "dotenv";
dotenv.config();

let connection;

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
    console.log("Клиент подключен");
    return { success: true, data: "Connected" };
  } catch (err) {
    console.error("Ошибка подключения:", err);
    return { success: false, error: err };
  }
}

async function subscribeListMatches() {
  if (!connection) throw new Error("Сначала подключите клиента");
  let response = await connection.invoke("SubscribeListMatches");
  return response;
}

async function subscribeMatch(gameId) {
  if (!connection) throw new Error("Сначала подключите клиента");

  try {
    
    const res = await connection.invoke("SubscribeMatch", gameId);
    connection.on("addMatch", (gameId, matchData) => {
        console.log('123123123')
    //     console.log(matchData);
        
    //   console.log(`Обновления для игры ${gameId}:`, matchData);
    });
    return res;
    return { success: true, data: { gameId, subscribed: true } };
  } catch (err) {
    console.error("Ошибка подписки:", err);
    return { success: false, error: err };
  }
}

async function unsubscribeMatch(gameId) {
  if (!connection) throw new Error("Сначала подключите клиента");

  try {
    await connection.invoke("UnsubscribeMatch", gameId);
    connection.off("ReceiveMatchUpdate");
    console.log(`Отписка от игры ${gameId} выполнена`);
    return { success: true, data: { gameId, subscribed: false } };
  } catch (err) {
    console.error("Ошибка отписки:", err);
    return { success: false, error: err };
  }
}

async function run() {
    const authData = { token: "123"};

    const connectResult = await connectClient(authData);
    if (!connectResult.success) return;

    let listMatches = subscribeListMatches()
    console.log(await listMatches)

    const gameId = 3646292;
    const responseSubscribe = await connection.invoke("SubscribeMatch", gameId);
    console.log(responseSubscribe.Data)

    connection.on("addMatch", (gameId, matchData) => {
        console.log(matchData);
        
        console.log('addMatch')
    })

    connection.on("event", (gameId, matchData) => {
        console.log(matchData);
        
        console.log('event')
    })

    connection.on("updateMatch", (gameId, matchData) => {
        console.log(matchData);
        
        console.log('updateMatch')
    })

    connection.on("removeMatch", (gameId, matchData) => {
        console.log(matchData);
        
        console.log('removeMatch')
    })
}

run().catch(console.error);