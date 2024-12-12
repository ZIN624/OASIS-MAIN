

  liff.init({
    liffId: '2006621786-8K7V4W3M'
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
// モーダルを閉じる関数
function closeModal() {
  document.getElementById('modal').style.display = 'none';
  document.getElementById('modal').classList.add('hidden');
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
let reservationData = {};

// 送信処理スタート
document.getElementById('submitReservation').addEventListener('click', function (event) {
  event.preventDefault(); // デフォルトの送信を防止
  console.log("submitReservation送信ボタンん押されたよお");

  // 入力チェック（共通化）
  if (!validateInputs()) return;

  // 入力内容を収集してグローバル変数に保存
  reservationData = {
    username: document.getElementById('username')?.value.trim(),
    phone: document.getElementById('phoneNumber')?.value.trim(),
    menu: document.getElementById('menu')?.value.trim(),
    stylist: document.getElementById('selectedStylistInput')?.value.trim(),
    preferences: ['1', '2', '3'].map(num => ({
      date: document.getElementById(`day${num}`)?.value || '',
      time: document.getElementById(`time${num}`)?.value || ''
    })).filter(pref => pref.date && pref.time),  // フィルタリング
    comments: document.getElementById('comments')?.value.trim()
  };

  // 予約詳細の確認内容を作成
  document.getElementById('reservationDetails').textContent = `予約希望内容:
  名前: ${reservationData.username}
  電話番号: ${reservationData.phone}
  ご希望メニュー: ${reservationData.menu}
  担当スタイリスト: ${reservationData.stylist}
  ${reservationData.preferences.map((pref, index) => `第${index + 1}希望: ${pref.date} ${pref.time}`).join('\n')}
  備考: ${reservationData.comments}`;

  // モーダルに予約内容を表示
  document.getElementById('modal').style.display = 'block';
  document.getElementById('modal').classList.remove('hidden');
});

// キャンセルボタン
document.getElementById('cancelReservation').addEventListener('click', function(event) {
  event.preventDefault(); // デフォルトの動作を防止
  closeModal();
});

// モーダル外をクリックしたら閉じる
window.addEventListener("click", function(event) {
  const modal = document.getElementById("modal");
  if (event.target === modal) {
    closeModal();
  }
});

// 予約を確定するボタン
document.getElementById("confirmReservation").addEventListener("click", function() {
  // 入力チェックを再度実行
  //if (!validateInputs()) return;

  console.log('ConfirmReservation押されたよお');

  // reservationDataを利用してメッセージ作成
  let message = `予約希望メッセージ\n\n予約者名: ${reservationData.username}\n`;
  reservationData.preferences.forEach((pref, index) => {
    const date = new Date(pref.date);
    const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
    message += `第${index + 1}希望: ${date.getMonth() + 1}月${date.getDate()}日 (${weekday}) ${pref.time}\n`;
  });
  message += `メニュー: ${reservationData.menu}\n担当スタイリスト: ${reservationData.stylist}\n電話番号: ${reservationData.phone}\nコメント: ${reservationData.comments}`;

  console.log('送信データ:', {
    message: message,
    isLoggedIn: liff.isLoggedIn(),
    liffId: liff.getContext().liffId
  });

  // LIFF初期化と送信の前に追加チェック
  if (!liff.isInitialized()) {
    alert('LINEフレームワークが初期化されていません。再読み込みしてください。');
    return;
  }

  // クライアント内かどうかを確認
  if (!liff.isInClient()) {
    alert('LINEアプリ内で実行してください。');
    return;
  }



  // メッセージ送信処理
  try {
    liff.sendMessages([{
      type: "text",
      text: "Hello WOrld",
    }])
    .then(() => {
      console.log('メッセージ送信成功');
      alert('予約希望が送信されました！');
        // 即座に閉じるのを遅らせる
    setTimeout(() => {
      liff.closeWindow();
    }, 3000); // 3秒後に閉じる
    })
    .catch((err) => {
      console.error('メッセージ送信エラー:', err);
      console.error('エラー詳細:', JSON.stringify(err, null, 2));
      
      // より詳細なエラーハンドリング
      let errorMessage = 'メッセージ送信に失敗しました。';
      if (err.message) {
        errorMessage += `\nエラー: ${err.message}`;
      }
      errorMessage += '\n以下を確認してください：' +
                      '\n1. インターネット接続' +
                      '\n2. LINEアプリ内で開いているか' +
                      '\n3. アプリの権限設定';
      
      alert(errorMessage);
    });
  } catch (error) {
    console.error('送信処理中の予期せぬエラー:', error);
    alert('送信処理中に予期せぬエラーが発生しました。');
  }
});
