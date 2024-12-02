const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const sharedSession = require("express-socket.io-session");
const noble = require("@abandonware/noble");

// BLE 장치 UUID (서비스 및 특성)
const HM10_SERVICE_UUID = "ffe0"; // HM-10 모듈 서비스 UUID
const HM10_CHARACTERISTIC_UUID = "ffe1"; // HM-10 모듈 특성 UUID

let weight = 0; // 수신된 무게 데이터를 저장

// Noble 이벤트: BLE 상태 변경 처리
noble.on("stateChange", (state) => {
  if (state === "poweredOn") {
    console.log("스캔 시작...");
    noble.startScanning([HM10_SERVICE_UUID], false); // HM-10 서비스 UUID를 스캔
  } else {
    noble.stopScanning(); // BLE 비활성화 시 스캔 중단
  }
});

// Express 앱 및 서버 설정
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

app.use(sessionMiddleware);

// 정적 파일 제공 (예: HTML, CSS, JS)
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
  const userSession = socket.handshake.session;

  // 세션에 사용자 정보가 없으면 로그인 페이지로 강제 이동
  if (!userSession.user) {
    socket.emit("redirect", "/"); // 클라이언트에게 리다이렉트 요청
    return;
  }

  const { name, drink, currentDrink, status } = userSession.user;

  // 음주량 비율 계산 (현재 음주량 / 주량) * 100
  const drinkPercentage = (currentDrink / drink) * 100;

  // 상태 결정: "정상", "주의", "위험" 설정
  let userStatus = status || "정상"; // 세션에 상태가 없으면 기본값 "정상"
  if (drinkPercentage >= 50 && drinkPercentage < 100) {
    userStatus = "주의";
  } else if (drinkPercentage >= 100) {
    userStatus = "위험";
  }

  console.log(`${name}님이 연결되었습니다.`);

  // 사용자 정보 저장
  users[socket.id] = { ...userSession.user, status: userStatus };
  io.emit("updateUserList", Object.values(users)); // 사용자 목록 갱신

  // 클라이언트에서 보낸 채팅 메시지 처리
  socket.on("chatMessage", (msg) => {
    io.emit("chatMessage", { user: name, message: msg });
  });

  // 연결 해제 처리
  socket.on("disconnect", () => {
    const user = users[socket.id];
    if (user) {
      console.log(`${user.name}님이 연결을 끊었습니다.`);
      delete users[socket.id]; // 사용자 제거
      io.emit("updateUserList", Object.values(users)); // 사용자 목록 갱신
    }
  });
});

// BLE 장치 발견 시 처리
noble.on("discover", (peripheral) => {
  const localName = peripheral.advertisement.localName;
  console.log("발견된 장치:", localName);

  // HM-10 장치 확인
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
        [HM10_SERVICE_UUID],
        [HM10_CHARACTERISTIC_UUID],
        (error, services, characteristics) => {
          if (error) {
            console.error("서비스 및 특성 검색 오류:", error);
            return;
          }

          const characteristic = characteristics[0];

          // BLE 데이터 수신 처리
          characteristic.on("data", (data, isNotification) => {
            try {
              // 데이터 변환
              weight = parseFloat(data.toString());
              console.log("수신한 무게 데이터:", weight);

              // 음주량 계산 로직
              let addedDrink = 0;
              if (weight >= 0.6) {
                addedDrink = 1;
              } else if (weight > 0.01 && weight < 0.6) {
                addedDrink = 0.5;
              } else {
                console.warn("유효하지 않은 무게 데이터:", weight);
              }

              // 사용자 상태 업데이트
              Object.values(users).forEach((user) => {
                if (user) {
                  user.currentDrink += addedDrink; // 음주량 증가
                  const drinkPercentage =
                    (user.currentDrink / user.drink) * 100;

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

              // 사용자 상태 클라이언트로 업데이트
              io.emit("updateUserList", Object.values(users));
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

            // 2초마다 BLE 장치로 사용자 음주량 정보 전송
            setInterval(() => {
              Object.values(users).forEach((user) => {
                if (user) {
                  const message = `a=${user.currentDrink}\nb=${user.drink}`;

                  // 로그 추가: BLE로 보낼 메시지를 출력
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
            }, 2000);
          });
        }
      );
    });
  }
});

// 클라이언트 로그인 처리
app.use(express.json());
app.post("/login", (req, res) => {
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
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`서버가 http://localhost:${PORT}에서 실행 중입니다.`);
});
