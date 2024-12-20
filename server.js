const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const sharedSession = require("express-socket.io-session");
const noble = require("@abandonware/noble");

// BLE 장치 UUID (서비스 및 특성)
const HM10_SERVICE_UUID = "ffe0"; // HM-10 모듈 서비스 UUID
const HM10_CHARACTERISTIC_UUID = "ffe1"; // HM-10 모듈 특성 UUID

let weight = 0; // 아두이노에서 보낸 무게 데이터를 저장할 변수

// Noble 이벤트: BLE 상태 변경 처리
noble.on("stateChange", (state) => {
  if (state === "poweredOn") {
    // BLE 상태가 활성화되면 장치 스캔 시작
    console.log("스캔 시작...");
    noble.startScanning([HM10_SERVICE_UUID], false); // HM-10 서비스 UUID만을 스캔
  } else {
    noble.stopScanning(); // BLE 비활성화 시 스캔 중단
  }
});

// Express 앱 및 HTTP 서버 설정
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 세션 설정
const sessionMiddleware = session({
  secret: "your-secret-key", // 보안을 위한 비밀 키
  resave: false, // 세션 강제 저장 방지
  saveUninitialized: true, // 초기화되지 않은 세션 저장 허용
  cookie: { secure: false }, // HTTPS 환경에서는 true로 설정 필요
});

app.use(sessionMiddleware); // Express에서 세션 미들웨어 사용

// 정적 파일 제공 (HTML, CSS, JS)
// `public/chat.html`, `public/chat.js`, `public/style.css`, `public/style2.css`, `public/index.html`, `public/script.js` 파일들을 클라이언트에게 제공
app.use(express.static("public"));

// Socket.IO와 세션 공유 설정
io.use(
  sharedSession(sessionMiddleware, {
    autoSave: true, // 세션 자동 저장
  })
);

const users = {}; // 사용자 정보를 저장하는 객체

// Socket.IO: 클라이언트 연결 처리
io.on("connection", (socket) => {
  const userSession = socket.handshake.session; // 클라이언트의 세션 정보 가져오기

  // 세션에 사용자 정보가 없으면 로그인 페이지로 강제 이동
  // 클라이언트는 `public/script.js`에서 이 리다이렉트를 처리해 적절한 HTML로 이동
  if (!userSession.user) {
    socket.emit("redirect", "/"); // 클라이언트에게 리다이렉트 요청
    return;
  }

  // 세션에서 사용자 정보 가져오기
  const { name, drink, currentDrink, status } = userSession.user;

  // 음주량 비율 계산 (현재 음주량 / 주량) * 100
  const drinkPercentage = (currentDrink / drink) * 100;

  // 상태 결정: 비율이 50 미만이면 "정상", 50 이상 100 미만이면 "주의", 100 이상 시 "위험"
  let userStatus = status || "정상";
  if (drinkPercentage >= 50 && drinkPercentage < 100) {
    userStatus = "주의";
  } else if (drinkPercentage >= 100) {
    userStatus = "위험";
  }

  console.log(`${name}님이 연결되었습니다.`);

  // 사용자 정보 저장
  users[socket.id] = { ...userSession.user, status: userStatus };
  io.emit("updateUserList", Object.values(users)); // 사용자 목록 갱신

   // 이 시점에 `public/script.js`, `public/chat.js`는 updateUserList 이벤트를 받아 대시보드에 사용자 상태를 표시

  // 클라이언트에서 보낸 채팅 메시지 처리
  // 클라이언트는 채팅 입력 필드(HTML)와 이벤트 핸들러(JS)를 통해 메시지를 서버로 보냄
  socket.on("chatMessage", (msg) => {
    io.emit("chatMessage", { user: name, message: msg }); // 모든 클라이언트에 메시지 전송
  });

  // 연결 해제 처리
  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) {
      console.log(`${user.name}님이 연결을 끊었습니다.`);
      delete users[socket.id]; // 연결이 끊어진 사용자 정보 삭제
      io.emit("updateUserList", Object.values(users)); // 사용자 목록 갱신
    }
  });
});

// BLE 장치 발견 시 처리
noble.on("discover", (peripheral) => {
  const localName = peripheral.advertisement.localName;
  console.log("발견된 장치:", localName);

  // 발견된 장치 이름에 "BT05" 포함 여부로 HM-10 장치 확인
  if (localName && localName.includes("BT05")) {
    console.log("HM-10 모듈 발견");

    noble.stopScanning(); // 스캔 중단

    // BLE 장치 연결
    peripheral.connect((error) => {
      if (error) {
        console.error("연결 오류:", error);
        return;
      }

      console.log("연결됨:", localName);

      // BLE 서비스 및 특성 검색
      peripheral.discoverSomeServicesAndCharacteristics(
        [HM10_SERVICE_UUID], // 검색할 서비스 UUID
        [HM10_CHARACTERISTIC_UUID], // 검색할 특성 UUID
        (error, services, characteristics) => {
          if (error) {
            console.error("서비스 및 특성 검색 오류:", error);
            return;
          }

          const characteristic = characteristics[0]; // 첫 번째 특성 선택

          // BLE 데이터 수신 처리
          characteristic.on("data", (data, isNotification) => {
            try {
              // 수신된 데이터(무게 데이터)를 숫자로 변환
              weight = parseFloat(data.toString());
              console.log("수신한 무게 데이터:", weight);

              // 음주량 계산 로직
              let addedDrink = 0;
              if (weight >= 18) {
                addedDrink = 1; // 무게가 18 이상이면 1 잔 추가
              } else if (weight > 1 && weight < 18) {
                addedDrink = 0.5; // 무게가 1~18 사이면 0.5(반 잔) 추가
              } else {
                console.warn("유효하지 않은 무게 데이터:", weight);
              }

              // 사용자 상태 업데이트
              Object.values(users).forEach((user) => {
                if (user) {
                  user.currentDrink += addedDrink; // 현재 음주량 정보 업데이트
                  const drinkPercentage =
                    (user.currentDrink / user.drink) * 100;

                  // 업데이트된 정보를 바탕으로 상태 업데이트  
                  if (drinkPercentage < 50) {
                    user.status = "정상";
                  } else if (drinkPercentage >= 50 && drinkPercentage < 100) {
                    user.status = "주의";
                  } else {
                    user.status = "위험";
                  }

                  console.log(
                    `${user.name}님: 음주량 ${user.currentDrink}, 상태 ${user.status}`
                  );
                }
              });

              // 갱신된 사용자 상태를 클라이언트로 업데이트
              io.emit("updateUserList", Object.values(users));

              // 갱신된 데이터를 `public/script.js`가 받아 화면을 동적으로 갱신

              // BLE로 사용자의 현재 음주량, 주량 정보 전송
              Object.values(users).forEach((user) => {
                if (user) {
                  const message = `a=${user.currentDrink}\nb=${user.drink}`;
                  console.log(`BLE로 보낼 메시지: ${message}`);

                  characteristic.write(Buffer.from(message), false, (error) => {
                    if (error) {
                      console.error("전송 오류:", error);
                    } else {
                      console.log("보낸 메시지:", message);
                    }
                  });
                }
              });
            } catch (error) {
              console.error("데이터 처리 오류:", error);
            }
          });

          // BLE 알림 구독
          characteristic.subscribe((error) => {
            if (error) {
              console.error("구독 오류:", error);
              return;
            }

            console.log("알림 구독 시작");
          });
        }
      );
    });
  }
});

// 클라이언트 로그인 처리
app.use(express.json());
app.post("/login", (req, res) => {
  // 로그인 시 이름, 주량, 현재 음주량을 입력(주량, 현재 음주량은 잔 수를 입력)
  const { name, drink, currentDrink } = req.body;

  if (!name || !drink || isNaN(drink) || isNaN(currentDrink)) {
    return res
      .status(400)
      .send("이름, 주량(숫자), 현재 음주량(숫자)을 입력하세요.");
  }

  // 상태 계산 및 저장
  const drinkPercentage = (currentDrink / drink) * 100;
  let status = "정상";

  if (drinkPercentage >= 50 && drinkPercentage < 100) {
    status = "주의";
  } else if (drinkPercentage >= 100) {
    status = "위험";
  }

  // 세션에 사용자 정보 저장
  req.session.user = {
    name,
    drink: parseFloat(drink),
    currentDrink: parseFloat(currentDrink),
    status,
  };

  res.send({ success: true });
});

// 로그아웃 처리
app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send("로그아웃에 실패했습니다.");
    }
    res.send({ success: true });
  });
});

// 서버 시작
const PORT = 3000; // 서버가 실행될 포트
server.listen(PORT, () => {
  console.log(`서버가 http://localhost:${PORT}에서 실행 중입니다.`);
});