liff.init({
  liffId: '2006621786-8K7V4W3M',
}).then(() => {
  console.log('LIFF初期化成功');
  console.log('LIFF環境情報:', {
    isInClient: liff.isInClient(),
    isLoggedIn: liff.isLoggedIn(),
    language: liff.getLanguage(),
    context: liff.getContext()
  });
      // 初期化成功時のアラート（デバッグ用）
      alert('LIFF初期化成功: クライアント内=' + liff.isInClient() + 
      ', ログイン状態=' + liff.isLoggedIn());
}).catch((error) => {
  console.error('LIFF初期化エラー:', error);
  console.error('エラー詳細:', JSON.stringify(error, null, 2));
  alert('LIFF初期化に失敗しました。以下の点を確認してください：\n' +
        '1. インターネット接続\n' +
        '2. LINEアプリ内で開いているか\n' +
        '3. LIFF IDが正しいか');
});


// 営業する特別な日（祝日など）
const specialWorkingDays = [
''  // 例: 12月23日（月曜日）を営業日として追加
];

// 休業日を追加 (通常の休日)
const holidays = [
'2024-12-25',  // 休業日
'2024-01-01'   // 休業日
];

// 日付生成関数
function generateDates() {
const today = new Date();
const maxDays = 180;  // 半年分の日付を生成
const dates = [];

// 今日の日付を追加
const formattedToday = `${today.getFullYear()}-${(today.getMonth() + 1).toString().padStart(2, '0')}-${today.getDate().toString().padStart(2, '0')}`;
const weekdayToday = ["日", "月", "火", "水", "木", "金", "土"][today.getDay()];
const isWeekendToday = (today.getDay() === 0 || today.getDay() === 6);

dates.push({
  date: formattedToday,
  weekday: weekdayToday,
  isWeekend: isWeekendToday
});

for (let i = 0; i < maxDays; i++) {
  const nextDate = new Date(today);
  nextDate.setDate(today.getDate() + i);
  const dayOfWeek = nextDate.getDay();

  // 月曜日と火曜日は除外
  if (dayOfWeek === 1 || dayOfWeek === 2) continue;

  // 日付をフォーマット
  const formattedDate = `${nextDate.getFullYear()}-${(nextDate.getMonth() + 1).toString().padStart(2, '0')}-${nextDate.getDate().toString().padStart(2, '0')}`;

  // 休暇日リストに含まれていれば、その日をスキップ
  if (holidays.includes(formattedDate)) continue;

  // 曜日を取得
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][nextDate.getDay()];

  // 土日なら赤色をつける
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);  // 日曜日(0)または土曜日(6)
  
  const dateWithStyle = {
    date: formattedDate,
    weekday: weekday,
    isWeekend: isWeekend
  };

  dates.push(dateWithStyle);
}

return dates;
}

function populateDateOptions(selectId) {
const daySelect = document.getElementById(selectId);
const dates = generateDates();

// 既存の選択肢をクリア
daySelect.innerHTML = '';

dates.forEach((dateObj, index) => {
  const option = document.createElement('option');
  option.value = dateObj.date;

  // 日付と曜日を適切に表示
  option.textContent = `${dateObj.date} (${dateObj.weekday})`;

  // 土日にはクラス "red-day" を追加
  if (dateObj.isWeekend) {
    option.classList.add('red-day');
  }

  // 初期選択（第1希望のデフォルト選択を今日に設定）
  if (index === 0) {
    option.selected = true;
  }

  daySelect.appendChild(option);
});
}

// 入力チェック関数
// スタイリスト選択のバリデーションを修正
function validateInputs() {
const username = document.getElementById('username')?.value.trim();
localStorage.setItem("username", username); // 入力内容を保存

if (!username) {
  alert('名前を入力してください。');
  return false;
}


const phone = document.getElementById('phoneNumber')?.value.trim();
if (!phone.match(/^0\d{1,4}-?(\d{1,4}){1,2}-?\d{4}$/)) {
  alert('電話番号は正しい形式で入力してください。');
  return false;
}

// メニュー選択のバリデーション
const menu = document.getElementById('menu')?.value.trim();
if (!menu) {
  alert('メニューを選択してください。');
  return false;
}

// スタイリスト選択のバリデーション
const selectedStylistInput = document.getElementById('selectedStylistInput');
const stylist = selectedStylistInput ? selectedStylistInput.value.trim() : '';
if (!stylist) {
  alert('担当スタイリストを選択してください。');
  return false;
}

return true;
}


// 名前と電話番号の自動入力
const nameInput = document.getElementById("username");
const phoneInput = document.getElementById("phoneNumber");

// 名前と電話番号の記憶
nameInput.value = localStorage.getItem("username") || '';
phoneInput.value = localStorage.getItem("phoneNumber") || '';

// 名前と電話番号を保存
nameInput.addEventListener('input', function() {
localStorage.setItem("username", nameInput.value);
});
phoneInput.addEventListener('input', function() {
localStorage.setItem("phoneNumber", phoneInput.value);
});

// スタイリスト選択
document.addEventListener('DOMContentLoaded', () => {
document.querySelectorAll('.stylist-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.stylist-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    
    const selectedStylistInput = document.getElementById('selectedStylistInput');
    if (selectedStylistInput) {
      selectedStylistInput.value = card.dataset.stylist;
    }
  });
});
});

// 第2希望の追加
document.getElementById('addSecondChoice').addEventListener('click', function () {
const secondChoiceDiv = document.getElementById('secondChoice');
if (!secondChoiceDiv.innerHTML) {
  secondChoiceDiv.innerHTML = `
    <h2 class="title">第2希望</h2>
    <div class="input-wrapper">
      <label for="day2" class="input-label">日付:</label>
      <select id="day2" name="day2" class="input-select" required></select>
    </div>
    <div class="input-wrapper">
      <label for="time2" class="input-label">時間:</label>
      <select id="time2" name="time2" class="input-select" required>
        ${[...Array(10).keys()].map(i => `<option value="${9 + i}:00">${9 + i}:00</option>`).join('')}
      </select>
    </div>`;
  populateDateOptions('day2');
} else {
  secondChoiceDiv.innerHTML = '';
}
});

// 第3希望の追加
document.getElementById('addThirdChoice').addEventListener('click', function () {
const thirdChoiceDiv = document.getElementById('thirdChoice');
if (!thirdChoiceDiv.innerHTML) {
  thirdChoiceDiv.innerHTML = `
    <h2 class="title">第3希望</h2>
    <div class="input-wrapper">
      <label for="day3" class="input-label">日付:</label>
      <select id="day3" name="day3" class="input-select" required></select>
    </div>
    <div class="input-wrapper">
      <label for="time3" class="input-label">時間:</label>
      <select id="time3" name="time3" class="input-select" required>
        ${[...Array(10).keys()].map(i => `<option value="${9 + i}:00">${9 + i}:00</option>`).join('')}
      </select>
    </div>`;
  populateDateOptions('day3');
} else {
  thirdChoiceDiv.innerHTML = '';
}
});

// 初期化
window.onload = function() {
populateDateOptions('day1');
};

// 予約データを収集する関数
let reservationData = {
  username: '',
  phone: '',
  menu: '',
  stylist: '',
  preferences: [], // ここで空の配列で初期化
  comments: ''
};

// 予約データの収集と表示
document.getElementById('submitReservation').addEventListener('click', function (event) {
  event.preventDefault();

  console.log('送信ボタンがクリックされました');

  // 予約データの収集
  const reservationData = {
    username: document.getElementById('username')?.value.trim(),
    phone: document.getElementById('phoneNumber')?.value.trim(),
    menu: document.getElementById('menu')?.value.trim(),
    stylist: document.getElementById('selectedStylistInput')?.value.trim(),
    
    // 予約の第1, 第2, 第3希望
    preferences: (['1', '2', '3'].map(num => {
      const date = document.getElementById(`day${num}`)?.value || ''; // 日付
      const time = document.getElementById(`time${num}`)?.value || ''; // 時間
      return { date, time }; // オブジェクトとして保存
    })).filter(pref => pref.date && pref.time),  // 日付と時間があるもののみフィルタリング

    comments: document.getElementById('comments')?.value.trim()
  };

  // `preferences` の内容をデバッグ
  console.log('収集した予約データ:', reservationData);

  // preferences の内容を詳細にログ出力
  console.log('preferences:', reservationData.preferences);

  // preferences が配列で、空でないかを確認
  if (!Array.isArray(reservationData.preferences) || reservationData.preferences.length === 0) {
    console.error('第1希望、第2希望、第3希望のいずれも入力されていません');
    alert('第1希望、第2希望、第3希望のいずれかを入力してください。');
    return; // preferencesが正しく設定されていない場合は処理を中止
  }

  // 確認内容を整形
  const detailsHTML = `
    <p><strong>予約者名:</strong> ${reservationData.username || '未入力'}</p>
    <p><strong>電話番号:</strong> ${reservationData.phone || '未入力'}</p>
    <p><strong>ご希望メニュー:</strong> ${reservationData.menu || '未入力'}</p>
    <p><strong>担当スタイリスト:</strong> ${reservationData.stylist || '未選択'}</p>
    ${reservationData.preferences.map((pref, index) => `
      <p><strong>第${index + 1}希望:</strong> ${pref.date} ${pref.time}</p>
    `).join('')}
    <p><strong>備考:</strong> ${reservationData.comments || "なし"}</p>
  `;

  // 確認エリアにデータを設定
  const summaryDetails = document.getElementById('summaryDetails');
  if (!summaryDetails) {
    console.error('summaryDetails 要素が見つかりません！');
    return;
  }
  summaryDetails.innerHTML = detailsHTML;

  // 確認エリアの表示切り替え
  const reservationSummary = document.getElementById('reservationSummary');
  const reservationForm = document.getElementById('reservationForm');
  if (!reservationSummary || !reservationForm) {
    console.error('reservationSummary または reservationForm 要素が見つかりません！');
    return;
  }

  reservationForm.style.display = 'none'; // フォームを非表示
  reservationSummary.style.display = 'block'; // 確認エリアを表示

  console.log('フォームのスタイル:', getComputedStyle(reservationForm).display);
  console.log('確認エリアのスタイル:', getComputedStyle(reservationSummary).display);
});






// 編集ボタン
document.getElementById('editReservation').addEventListener('click', function () {
  document.getElementById('reservationSummary').style.display = 'none';
  document.getElementById('reservationForm').style.display = 'block';
});

// 確定ボタン
document.getElementById('confirmReservation').addEventListener('click', function () {
  let message = `
    予約希望メッセージ:
    予約者名: ${reservationData.username || '（未入力）'}
    電話番号: ${reservationData.phone || '（未入力）'}
    メニュー: ${reservationData.menu || '（未入力）'}
    スタイリスト: ${reservationData.stylist || '（未入力）'}
    備考: ${reservationData.comments || '（未入力）'}
  `;

  // preferencesが配列であり、かつ空でないかを確認
  if (Array.isArray(reservationData.preferences) && reservationData.preferences.length > 0) {
    message += `\n希望日時:\n${reservationData.preferences.map((pref, index) => {
      if (pref && pref.date && pref.time) { // prefの日付と時間が正しく存在するかを確認
        return `第${index + 1}希望: ${pref.date} ${pref.time}`;
      } else {
        return `第${index + 1}希望: （未入力）`; // 日付または時間が未入力の場合
      }
    }).join('\n')}`;
  } else {
    message += '\n希望日時: （未入力）';
  }

  liff.sendMessages([{
    type: 'text',
    text: message
  }]).then(() => {
    alert('予約希望が送信されました！');
    liff.closeWindow();
  }).catch((error) => {
    alert(`エラー: ${error.message}`);
  });
});




  
