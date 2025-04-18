const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const router = express.Router();
require('dotenv').config();

const host = process.env.API_HOST;
const wsHost = process.env.WS_HOST;

// 創建 WebSocket Server
const clientWs = new WebSocket.Server({ port: 8080 }); // 你可以自訂 port

clientWs.on('connection', (ws) => {
  console.log('WebSocket Server: Client connected');

  ws.on('close', () => {
    console.log('WebSocket Server: Client disconnected');
  });
});

// 取得 3CX token
async function get3cxToken (grant_type, client_id, client_secret) {
  try {
    const params = new URLSearchParams();
    params.append('grant_type', grant_type);
    params.append('client_id', client_id);
    params.append('client_secret', client_secret);

    const response = await axios.post(`${host}/connect/token`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    // console.log('取得 3CX token 成功:', response.data.access_token);
    return response.data.access_token;
  } catch (error) {
    console.error('Error get3cxToken request:', error.message);
    throw new Error('Failed to fetch token');
  }
};

// 取得撥號者 讓 queue 去撥通電話
async function getCaller (token) {
  try {
    const response = await axios.get(`${host}/callcontrol`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const caller = response.data.find(item => item.type === 'Wqueue');
    if (!caller) {
      throw new Error('Caller not found');
    }

    return caller;
  } catch (error) {
    console.error('Error getCaller request:', error.message);
    throw new Error('Failed to getCaller data');
  } 
};

async function makeCall (token, dn, device_id, reason, destination, timeout = 30) {
  try {
    const response = await axios.post(`${host}/callcontrol/${dn}/devices/${device_id}/makecall`, {
      reason,
      destination,
      timeout
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // 回傳 API 的回應
    return response.data;
  } catch (error) {
    console.error('Error makeCall request:', error.message);
    throw new Error('Failed to makecall');
  }
};

async function hangupCall (token, dn, id) {
  try {
    const response = await axios.post(`${host}/callcontrol/${dn}/participants/${id}/drop`, {}, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    console.log('成功 掛斷電話請求:', response.data);
    // 回傳 API 的回應
    return response.data;
  } catch (error) {
    console.error('Error hangupCall request:', error.message);
    throw new Error('Failed to hangupCall');
  }
};

// 取得參與者資訊 電話撥出時可用來抓取對方是否接聽
async function getParticipants (token, dn) {
  try {
    const response = await axios.get(`${host}/callcontrol/${dn}/participants`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    // console.log('參與者資訊：', response.data);
    return response.data;
  } catch (error) {
    console.error('Error getParticipants request:', error.message);
    throw new Error('Failed to get participants');
  }
};

// 建立 WebSocket 連線 查看自動撥號狀態
function createWs (token, phones, dn, device_id, caller, client_id) {
  const phoneNumbersArray = phones.split(',');
  let nowCall = 0;

  try {
    // 建立 WebSocket 連線
    const ws = new WebSocket(`${wsHost}/callcontrol/ws`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    ws.on('open', async function open() {
      // console.log('WebSocket connection established');

      // 進行初次撥打電話
      const phoneNumbersArray = phones.split(',');
      console.log(`撥打者 ${client_id} / 準備撥給 第 ${nowCall + 1} 隻手機: ${phoneNumbersArray[nowCall]}`);
      await makeCall(token, dn, device_id, 'outbound', phoneNumbersArray[0]);
    });

    ws.on('message', async function message(data) {
      try {
        // 取得參與者資訊
        const participants = await getParticipants(token, dn);
        // console.log('參與者資訊 : ', participants);

        // 將 Buffer 轉換為字串
        const messageString = data.toString();
    
        // 如果是 JSON 格式，嘗試解析
        const messageJson = JSON.parse(messageString);
    
        // console.log('WebSocket server 接收數據 : ', messageJson);

        const { event_type } = messageJson.event;

        // 整合 參與者資訊 和 WebSocket server 接收數據
        // console.log('caller.devices:', caller.devices);
        const resultData = {
          ...messageJson,
          client_id,
          caller: {
            dn: caller.dn,
            type: caller.type,
            devices: caller.devices,
          },
          participants: participants
        }

        // if(client_id === 'leo'){
        //   console.error('整合 參與者資訊 和 WebSocket server 接收數據 : ', resultData);
        // } else {
        //   console.log('整合 參與者資訊 和 WebSocket server 接收數據 : ', resultData);
        // }

        // console.log('整合 參與者資訊 和 WebSocket server 接收數據 : ', resultData);
        

        // 傳送 resultData 給 WebSocket Server 的所有連線客戶端
        clientWs.clients.forEach((client) => {
          client.send(JSON.stringify(resultData));
        });
        
        if (event_type === 1) {
          console.log('event_type:', event_type);
          nowCall++;
          console.log('=================== 我是分隔線 ====================');
          // console.log(`撥打者 ${caller.dn} / 前一隻手機掛斷了 5秒後準備撥給 第 ${nowCall + 1} 隻手機: ${phoneNumbersArray[nowCall]}`);
          console.log(`撥打者 ${client_id} / 前一隻手機掛斷了 5秒後準備撥給下隻手機`);
          if (!phoneNumbersArray[nowCall]) {
            console.log('沒有更多的電話號碼可以撥打');
            nowCall = 0; // 重置計數器
            ws.close(); // 關閉 WebSocket 連線
            return;
          } else {
            // 等待 5 秒後撥打下一個電話
            setTimeout(async () => {
              console.log(`撥打者 ${client_id} / 準備撥給 第 ${nowCall + 1} 隻手機: ${phoneNumbersArray[nowCall]}`);
              await makeCall(token, dn, device_id, 'outbound', phoneNumbersArray[nowCall]);
            }, 5000);
          }
        }

      } catch (error) {
        // 如果不是 JSON 格式，直接輸出字串
        console.log('Received raw message from WebSocket server:', data.toString());
      }
    });

    ws.on('close', function close() {
      // console.log('WebSocket connection closed');
    });

    ws.on('error', function error(err) {
      // console.error('WebSocket error:', err.message);
      throw new Error('WebSocket connection error');
    });

  } catch (error) {
    console.error('Error establishing WebSocket connection:', error.message);
    throw new Error('Failed to establish WebSocket connection');
  }
};

// 主要 的 API
router.post('/', async function(req, res, next) {
  const { grant_type, client_id, client_secret, phones } = req.body;

  if (!grant_type || !client_id || !client_secret || !phones) {
    return res.status(400).send('Missing required fields');
  }
  try {
    // 先取得 3CX token 
    const token = await get3cxToken(grant_type, client_id, client_secret);
    // console.log(token);

    // 取得 撥號分機資訊 (需要設定 queue)
    const caller = await getCaller(token);
    const { dn, device_id } = caller.devices[0]; // TODO 這邊我只有取第一台設備資訊

    // 建立 WebSocket 連線
    try {
      createWs(token, phones, dn, device_id, caller, client_id);
    } catch (error) {
      console.error('Error establishing WebSocket connection:', error.message);
    }

    // // Log the received data (for debugging purposes)
    // console.log({ grant_type, client_id, client_secret, phones });

    res.status(200).send('Request outboundCampaigm successfully');
  } catch (error) {
    console.error('Error in POST /:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

// 掛斷當前撥號的對象
router.post('/hangup', async function(req, res, next) {
  const {dn, id} = req.body;
  if (!dn || !id) {
    return res.status(400).send('Missing required fields');
  }
  try {
    // 進行掛斷電話
    await hangupCall(dn, id);
    res.status(200).send('Request hangup successfully');
  } catch (error) {
    console.error('Error in POST /hangup:', error.message);
    return res.status(500).send('Internal Server Error');
  }
});

module.exports = router;
