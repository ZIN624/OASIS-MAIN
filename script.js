  liff.init({
    liffId: '2006621786-8K7V4W3M' // LINE Developersから取得したLIFF ID
  }).then(() => {
    console.log('LIFF initialized');
  }).catch((error) => {
    console.error('LIFF initialization failed:', error);
  });

// 営業する特別な日（祝日など）
const specialWorkingDays = [
  '2024-12-23'  // 例: 12月23日（月曜日）を営業日として追加
];

// 休暇日を追加 (通常の休日)
const holidays = [
  '2024-12-25',  // 休業日
  '2024-01-01'   // 休業日
];

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

document.getElementById('phoneNumber').addEventListener('input', function (e) {
  const phoneInput = e.target.value;
  const isValid = /^(\d{2,4}-?\d{2,4}-?\d{4})$/.test(phoneInput); // ハイフンあり・なし対応
  if (!isValid) {
    e.target.setCustomValidity('電話番号は正しい形式で入力してください（例: 090-1234-5678 または 09012345678）');
  } else {
    e.target.setCustomValidity('');
  }
});

// 名前と電話番号の自動入力
const nameInput = document.getElementById("name");
const phoneInput = document.getElementById("phoneNumber");

// 名前と電話番号の記憶
nameInput.value = localStorage.getItem("name") || '';
phoneInput.value = localStorage.getItem("phoneNumber") || '';

// 名前と電話番号を保存
nameInput.addEventListener('input', function() {
  localStorage.setItem("name", nameInput.value);
});
phoneInput.addEventListener('input', function() {
  localStorage.setItem("phoneNumber", phoneInput.value);
});

// 日付更新処理
function updateDays(monthId, dayId) {
  const month = parseInt(document.getElementById(monthId).value);
  const year = 2024;
  const daysInMonth = new Date(year, month, 0).getDate();

  let daysOptions = '';
  for (let i = 1; i <= daysInMonth; i++) {
    daysOptions += `<option value="${i}">${i}日</option>`;
  }

  const daysSelect = document.getElementById(dayId);
  daysSelect.innerHTML = daysOptions;
}

// スタイリスト選択
document.querySelectorAll('.stylist-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.stylist-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    document.querySelector('#selectedStylistInput').value = card.dataset.stylist;
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

// 送信処理
document.getElementById('submitReservation').addEventListener('click', function (event) {
  event.preventDefault(); // デフォルトの送信を防止

  // 入力内容の取得
  const name = document.getElementById('name').value.trim();
  const phone = document.getElementById('phoneNumber').value.trim();
  const menu = document.getElementById('menu').value.trim();
  const comments = document.getElementById('comments').value.trim();
  const stylist = document.getElementById('selectedStylistInput')?.value.trim() || '';

  // 入力チェック（名前と電話番号は必須）
  if (!name) {
    alert('名前を入力してください。');
    return;
  }

  if (!phone.match(/^0\d{1,4}-?\d{1,4}-?\d{4}$/)) {
    alert('電話番号は「09012345678」または「090-1234-5678」の形式で入力してください。');
    return;
  }

  if (!stylist) {
    alert('担当スタイリストをお選びください');
    return;
  }

  // 第1～第3希望を取得
  const preferences = ['1', '2', '3'].map(num => ({
    date: document.getElementById(`day${num}`)?.value || '',
    time: document.getElementById(`time${num}`)?.value || '',
  })).filter(pref => pref.date && pref.time); // 空の希望を除外

  // 予約詳細の確認内容を作成
  document.getElementById('reservationDetails').textContent = `予約希望内容:
  名前: ${name}
  電話番号: ${phone}
  ご希望メニュー: ${menu}
  担当スタイリスト: ${stylist}
  ${preferences.map((pref, index) => `第${index + 1}希望: ${pref.date} ${pref.time}`).join('\n')}
  備考: ${comments}`;

  // モーダルに予約内容を表示
  document.getElementById('modal').style.display = 'block';
  document.getElementById('modal').classList.remove('hidden');
});

// モーダルを閉じる関数を共通化
function closeModal() {
  document.getElementById('modal').style.display = 'none';
  // モーダルを閉じてもフォームの入力値を保持
  document.getElementById('modal').classList.remove('hidden');
}
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
  const name = document.getElementById('name').value.trim();
  const phone = document.getElementById('phoneNumber').value.trim();
  const menu = document.getElementById('menu').value.trim();
  const stylist = document.getElementById('selectedStylistInput')?.value.trim() || '';
  const comments = document.getElementById('comments').value.trim();

  // 予約希望の取得（第1希望、第2希望、第3希望）
  const preferences = ['1', '2', '3'].map(num => ({
    date: document.getElementById(`day${num}`)?.value || '',
    time: document.getElementById(`time${num}`)?.value || '',
  })).filter(pref => pref.date && pref.time);

  
  
  if (!name) {
    // 名前が空の場合
    setNameError('名前を入力してください');
    return;
  }
  if (!phone) {
    // 電話番号が空の場合
    setNameError('電話番号を入力してください');
    return;
  }
  if (!menu) {
    // メニューが空の場合
    setNameError('ご希望のメニューを入力してください');
    return;
  }
  if (!selectedStylistInput) {
    // 担当スタイリスト
    setNameError('担当スタイリストをお選びください');
    return;
  }
  

  // 予約詳細メッセージ作成
  let message = `
  予約希望メッセージ\n\n予約者名: ${name}\n`;
  preferences.forEach((pref, index) => {
    const date = new Date(pref.date); // 日付をDateオブジェクトに変換
    const weekday = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
    message += `第${index + 1}希望: ${date.getMonth() + 1}月${date.getDate()}日 (${weekday}) ${pref.time}\n`;
  });
  message += `メニュー: ${menu}\n担当スタイリスト: ${stylist}\n電話番号: ${phone}\nコメント: ${comments}
  
  ご記入ありがとうございました！
  確認次第ご連絡いたしますのでお待ちください！`;

// 送信するメッセージ内容をコンソールに表示
console.log("送信内容:", message);

  // LINEメッセージ送信
  liff.sendMessages([{
    type: 'text',
    text: message
  }])
  .then(() => {
    console.log("メッセージ送信成功",message);
    alert('予約希望が送信されました！');
    closeModal();  // モーダルを閉じる
    liff.closeWindow();  // LIFFウィンドウを閉じる
  })
  .catch(error => {
    console.error('メッセージ送信エラー:', error);
    alert('エラーが発生しました: ' + error.message);
  });
  
  
    document.addEventListener('DOMContentLoaded', () => {
      console.log('DOMContentLoaded event fired');
      populateDateOptions('day1');
    });})
