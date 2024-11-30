const socket = io();

// 채팅 메시지 전송
document.getElementById("sendChatBtn").addEventListener("click", () => {
  const chatInput = document.getElementById("chatInput");
  const message = chatInput.value.trim();
  if (message) {
    socket.emit("chatMessage", message); // 서버로 메시지 전송
    chatInput.value = ""; // 입력 필드 초기화
  }
});

// 사용자 목록 업데이트
socket.on("updateUserList", (users) => {
  const userList = document.getElementById("userList");
  userList.innerHTML = users
    .map(
      (user) =>
        `<li>${user.name} - 주량: ${user.drink}, 현재 음주량: ${user.currentDrink}, 상태: ${user.status}</li>`
    )
    .join("");
});

// 채팅 메시지 수신
socket.on("chatMessage", (msg) => {
  const chatBox = document.getElementById("chatBox");
  chatBox.innerHTML += `<p><strong>${msg.user}:</strong> ${msg.message}</p>`;
});

// 서버 리다이렉트 이벤트 처리
socket.on("redirect", (url) => {
  window.location.href = url;
});