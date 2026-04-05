# Game Server - Tarneeb

## هيكل المشروع

```
backend/
├── games/
│   ├── base/
│   │   └── BaseGame.js          # كلاس أساسي للألعاب
│   ├── tarneeb/
│   │   ├── TarneebGame.js       # منطق طرنيب كامل
│   │   └── tarneeb.rules.js     # قواعد التحقق
│   └── utils/
│       └── cards.js             # تمثيل الكروت { suit, rank }
├── matchmaking/
│   └── matchMaker.js            # جمع لاعبين وإنشاء غرف
├── rooms/
│   └── roomManager.js           # إدارة الغرف والألعاب
└── socket/
    ├── index.js                 # namespace /game + JWT auth
    └── handlers/
        └── game.handlers.js     # معالجات join_game, bid, play_card, leave_room
```

## Socket.io - namespace `/game`

### الاتصال
```js
const socket = io("http://localhost:8000/game", {
  auth: { token: "YOUR_JWT_TOKEN" }
});
```

### أحداث من الكلاينت (Client → Server)

| Event | Payload | الوصف |
|-------|---------|-------|
| `join_game` | `{ gameType: "tarneeb" }` | الانضمام للطابور |
| `bid` | `{ roomId, value: 7\|8\|...\|13\|"pass" }` | المزايدة |
| `choose_trump` | `{ roomId, trump: "hearts"\|"spades"\|"clubs"\|"diamonds" }` | اختيار الترامب (بعد الفوز بالمزايدة) |
| `play_card` | `{ roomId, card: { suit, rank } }` | لعب ورقة |
| `next_round` | `{ roomId }` | بداية الجولة التالية (بعد round_result) |
| `leave_room` | `{ roomId }` | مغادرة الغرفة |

### أحداث من السيرفر (Server → Client)

| Event | Payload | الوصف |
|-------|---------|-------|
| `room_joined` | `{ roomId, seatIndex, gameState }` أو `{ waiting: true, queueSize, required }` | تم الانضمام |
| `game_state` | `{ state, hands, trick, currentPlayerIndex, validCards, ... }` | حالة اللعبة |
| `invalid_move` | `{ reason }` | حركة غير صحيحة |
| `round_result` | `{ teamScores, roundTricks, declarerTeam, bidValue }` | نتيجة الجولة |
| `game_finished` | `{ winnerTeam, teamScores }` | انتهاء اللعبة |

### تمثيل الكرت
```js
{ suit: "hearts" | "spades" | "clubs" | "diamonds", rank: 2..14 }
// 11=J, 12=Q, 13=K, 14=A
```

### game_state - لا يُرسل أوراق الخصوم
- كل لاعب يستقبل `hands` حيث أوراقه فقط مرئية، والباقي `null`
- `validCards` = الأوراق المسموح لعبها حالياً

## إضافة لعبة جديدة

1. أنشئ `games/NEWGAME/NewGame.js` يرث من `BaseGame`
2. أضف في `roomManager.js`: `GAME_CLASSES.newgame = NewGame`
3. أضف في `matchMaker.js`: `GAME_REQUIREMENTS.newgame = N`
4. أضف معالجات في `game.handlers.js` إذا لزم
