// 사이트 설정. endpoint 는 구글 앱스 스크립트 웹 앱 주소로, 구글 시트·드라이브와 이어 줍니다.
// endpoint 를 비워 두면 시험 모드입니다(data/stores.json 의 가짜 점포와 시험용 접속 코드를 쓰고, 사진은 어디로도 전송되지 않습니다).
window.APP_CONFIG = {
  endpoint: 'https://script.google.com/macros/s/AKfycbyUoFC-lJHr1kkTkqty4Yp9t52IoutpBFd1MWU3yF8v6tKiGVibrgWAQBlJ_YFQsmc4_A/exec',
  imageMaxEdge: 1600,
  imageQuality: 0.82,
};
