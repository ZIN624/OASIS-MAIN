// ========== LIFF初期化 ========== //
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
}).catch((error) => {
  console.error('LIFF初期化エラー:', error);
  console.error('エラー詳細:', JSON.stringify(error, null, 2));
  alert('LIFF初期化に失敗しました。以下の点を確認してください：\n' +
        '1. インターネット接続\n' +
        '2. LINEアプリ内で開いているか\n' +
        '3. LIFF IDが正しいか');
});

// =========== 次へ,、戻る挙動 =============//


  const steps = [
    'reserveForm_customerInfo',
    'reserveForm__date',
    'reserveForm__menu',
    'reserveForm__stylisyt'
  ];

  let currentStepIndex = 0;
  document.addEventListener('DOMContentLoaded', () => {
  // ========== 次へ進む ==========
  function goToNextStep() {
    if (!validateStep(currentStepIndex)) return;
  
    const currentId = steps[currentStepIndex];
    const nextId = steps[currentStepIndex + 1];
    if (!nextId) return;
  
    document.getElementById(currentId).style.display = 'none';
    document.getElementById(nextId).style.display = 'block';
    currentStepIndex++;
  
    updateStepIndicator(currentStepIndex); 
  }
  
  // ========== 戻る ==========
  function goToPreviousStep() {
    const currentId = steps[currentStepIndex];
    const prevId = steps[currentStepIndex - 1];

    if (!prevId) return;

    document.getElementById(currentId).style.display = 'none';
    document.getElementById(prevId).style.display = 'block';

    currentStepIndex--;

    updateStepIndicator(currentStepIndex);
  }

  // ========== イベント登録 ==========
  // 「次へ」ボタン
  document.getElementById('btn__next--first')?.addEventListener('click', goToNextStep);
  document.getElementById('btn__next--second')?.addEventListener('click', goToNextStep);
  document.getElementById('btn__next--third')?.addEventListener('click', goToNextStep);

  // 「戻る」ボタン
  document.getElementById('btn__prev--second')?.addEventListener('click', goToPreviousStep);
  document.getElementById('btn__prev--third')?.addEventListener('click', goToPreviousStep);
  document.getElementById('btn__prev--fourth')?.addEventListener('click', goToPreviousStep);

  // 最後のステップから確認画面へ
  document.getElementById('btn__next--fourth')?.addEventListener('click', () => {
    // 入力セクションをすべて非表示
    steps.forEach(stepId => {
      const section = document.getElementById(stepId);
      if (section) section.style.display = 'none';
    });

    // 確認画面を表示
    const summary = document.getElementById('reservationSummary');
    summary.style.display = 'block';
    summary.scrollIntoView({ behavior: 'smooth' });
  });

  // 「内容を変更」ボタンでステップ4に戻る
  document.getElementById('editReservation')?.addEventListener('click', () => {
    document.getElementById('reservationSummary').style.display = 'none';

    // 最後のステップを表示
    currentStepIndex = steps.length - 1;
    steps.forEach((id, i) => {
      document.getElementById(id).style.display = (i === currentStepIndex) ? 'block' : 'none';
    });
  });
  updateStepIndicator(currentStepIndex); 
});

function updateStepIndicator(currentStepIndex) {
  const stepCount = 4;

  for (let i = 0; i < stepCount; i++) {
    const step = document.getElementById(`step-${i}`);
    const circle = step.querySelector('.circle');
    step.classList.remove('active', 'completed');

    if (i < currentStepIndex) {
      step.classList.add('completed');
      circle.textContent = '✓';
    } else {
      circle.textContent = i + 1;
    }

    if (i === currentStepIndex) {
      step.classList.add('active');
    }

    // 線の更新（lineはステップ数-1本）
    const line = document.querySelectorAll('.line')[i];
    if (line) {
      if (i < currentStepIndex) {
        line.classList.add('active');
      } else {
        line.classList.remove('active');
      }
    }
  }
}



// ========== 2. 日付生成と特別営業日・休業日定義 ========== //

const specialWorkingDays = [

];

const holidays =
  ['2025-12-31',
   '2026-01-01',
   '2026-01-02',
   '2026-01-03',
   '2026-01-11',
   '2026-02-27',
    "2026-04-07",
  ];




function generateDates(maxDays = 180) {
  const today = new Date();
  const dates = [];
  const startDate = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  for (let i = 0; i < maxDays; i++) {
    const currentDate = new Date(startDate);
    currentDate.setUTCDate(startDate.getUTCDate() + i);
    const dayOfWeek = currentDate.getUTCDay();
    const formattedDate = currentDate.toISOString().split('T')[0];
    if (dayOfWeek === 1 || dayOfWeek === 2 || holidays.includes(formattedDate)) continue;
    dates.push({
      date: formattedDate,
      weekday: ["日", "月", "火", "水", "木", "金", "土"][dayOfWeek],
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    });
  }
  specialWorkingDays.forEach((day) => {
    if (!dates.some((d) => d.date === day)) {
      const specialDate = new Date(day);
      dates.push({
        date: day,
        weekday: ["日", "月", "火", "水", "木", "金", "土"][specialDate.getDay()],
        isWeekend: specialDate.getDay() === 0 || specialDate.getDay() === 6,
      });
    }
  });
  return dates.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ========== 3. 日付選択肢の反映 ========== //
function populateDateOptions(selectId) {
  const daySelect = document.getElementById(selectId);
  const dates = generateDates();
  daySelect.innerHTML = '';
  dates.forEach((dateObj, index) => {
    const option = document.createElement('option');
    option.value = dateObj.date;
    option.textContent = `${dateObj.date} (${dateObj.weekday})`;
    if (dateObj.isWeekend) option.classList.add('red-day');
    if (index === 0) option.selected = true;
    daySelect.appendChild(option);
  });
}

window.onload = function() {
  populateDateOptions('day1');
};

// ========== 4. 特別営業日追加関数 ========== //
function addSpecialWorkingDay(newDay) {
  if (!specialWorkingDays.includes(newDay)) {
    specialWorkingDays.push(newDay);
    console.log(`特別営業日 ${newDay} を追加しました。`);
    populateDateOptions('day1');
  } else {
    console.warn(`${newDay} は既に特別営業日に含まれています。`);
  }
}

// ========== 5. 入力の保存と復元（localStorage） ========== //
const nameInput = document.getElementById("username");
const phoneInput = document.getElementById("phoneNumber");
const furiganaInput = document.getElementById("furigana");
const genderInputs = document.getElementsByName("gender");

nameInput.value = localStorage.getItem("username") || '';
phoneInput.value = localStorage.getItem("phoneNumber") || '';
furiganaInput.value = localStorage.getItem("furigana") || '';
const savedGender = localStorage.getItem("gender");
if (savedGender) {
  genderInputs.forEach(input => {
    if (input.value === savedGender) input.checked = true;
  });
}

nameInput.addEventListener('input', () => {
  localStorage.setItem("username", nameInput.value);
});
phoneInput.addEventListener('input', () => {
  localStorage.setItem("phoneNumber", phoneInput.value);
});
furiganaInput.addEventListener('input', () => {
  localStorage.setItem("furigana", furiganaInput.value);
});
genderInputs.forEach(input => {
  input.addEventListener('change', () => {
    if (input.checked) localStorage.setItem("gender", input.value);
  });
});

// ========== 6. スタイリスト選択イベント ========== //
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

// ========== 7. 希望日時の追加（第2・第3希望） ========== //
document.getElementById('addSecondChoice').addEventListener('click', () => {
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

document.getElementById('addThirdChoice').addEventListener('click', () => {
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

// ========== 8. 入力チェック関数 ========== //
function validateStep(stepIndex) {
  switch (stepIndex) {
    case 0: {
      const username = document.getElementById('username')?.value.trim();
      const furigana = document.getElementById('furigana')?.value.trim();
      const gender = document.querySelector('input[name="gender"]:checked')?.value;
      const phone = document.getElementById('phoneNumber')?.value.trim();
      const furiganaPattern = /^[ぁ-んァ-ンー\s]+$/;

      if (!username) return alert('名前を入力してください。'), false;
      if (!furigana) return alert('フリガナを入力してください。'), false;
      if (!furiganaPattern.test(furigana)) return alert('フリガナは「ひらがな」「カタカナ」のみで。'), false;
      if (!gender) return alert('性別を選択してください。'), false;
      if (!phone.match(/^0\d{1,4}-?(\d{1,4}){1,2}-?\d{4}$/)) return alert('電話番号の形式が正しくありません。'), false;
      return true;
    }

    case 1: {
      const day1 = document.getElementById('day1')?.value;
      const time1 = document.getElementById('time1')?.value;
      if (!day1 || !time1) return alert('第1希望の日時を選択してください。'), false;
      return true;
    }

    case 2: {
      const menu = document.getElementById('menu')?.value.trim();
      if (!menu) return alert('メニューを入力してください。'), false;
      return true;
    }

    case 3: {
      const stylist = document.getElementById('selectedStylistInput')?.value.trim();
      if (!stylist) return alert('スタイリストを選択してください。'), false;
      return true;
    }

    default:
      return true;
  }
}

// ========== 9. 予約データの初期構築（仮のreservationData） ========== //
let reservationData = {
  username: document.getElementById('username')?.value.trim(),
  phone: document.getElementById('phoneNumber')?.value.trim(),
  menu: document.getElementById('menu')?.value.trim(),
  stylist: document.getElementById('selectedStylistInput')?.value.trim(),
  furigana: document.getElementById('furigana')?.value.trim(),
  gender: document.querySelector('input[name="gender"]:checked')?.value,
  preferences: ['1', '2', '3'].map(num => ({
    date: document.getElementById(`day${num}`)?.value || '',
    time: document.getElementById(`time${num}`)?.value || ''
  })).filter(pref => pref.date && pref.time),
  comments: document.getElementById('comments')?.value.trim(),
  agree: document.getElementById('agreeCheckbox')?.checked || false
};

// ========== 10. 送信ボタン処理（予約内容確認画面へ） ========== //
document.getElementById('submitReservation').addEventListener('click', function (event) {
  event.preventDefault();
  console.log('送信ボタンがクリックされました');
  console.log('予約データ:', reservationData);

  if (!validateStep(currentStepIndex)) return;


  const username = document.getElementById('username').value.trim();
  const furigana = document.getElementById('furigana')?.value.trim();
  const phone = document.getElementById('phoneNumber').value.trim();
  const menu = document.getElementById('menu').value.trim();
  const stylist = document.getElementById('selectedStylistInput').value.trim();
  const gender = document.querySelector('input[name="gender"]:checked')?.value;

  if (!username || !furigana || !gender || !menu || !stylist || !phone) {
    alert('必須項目がすべて入力されていることを確認してください');
    return;
  }

  reservationData = {
    username,
    phone,
    menu,
    stylist,
    furigana,
    gender,
    preferences: (['1', '2', '3'].map(num => {
      const date = document.getElementById(`day${num}`)?.value || '';
      const time = document.getElementById(`time${num}`)?.value || '';
      return { date, time };
    })).filter(pref => pref.date && pref.time),
    comments: document.getElementById('comments')?.value.trim()
  };

  if (!Array.isArray(reservationData.preferences) || reservationData.preferences.length === 0) {
    alert('第1希望、第2希望、第3希望のいずれかを入力してください。');
    return;
  }

  const detailsHTML = `
    <p><strong>予約者名<p></strong> ${reservationData.username}</p>
    <p><strong>フリガナ<p></strong> ${reservationData.furigana || '未入力'}</p>
    <p><strong>性別<p></strong> ${reservationData.gender || '未選択'}</p>
    <p><strong>電話番号<p></strong> ${reservationData.phone || '未入力'}</p>
    <p><strong>ご希望メニュー<p></strong> ${reservationData.menu || '未入力'}</p>
    <p><strong>ご希望スタイリスト<p></strong> ${reservationData.stylist || '未入力'}</p>
    ${reservationData.preferences.map((pref, index) => `
    <p><strong>第${index + 1}希望<p></strong> ${pref.date} ${pref.time}</p>
    `).join('')}
    <p><strong>備考<p></strong> ${reservationData.comments || "なし"}</p>
  `;

  const summaryDetails = document.getElementById('summaryDetails');
  if (!summaryDetails) return;
  summaryDetails.innerHTML = detailsHTML;
  console.log(detailsHTML)

  const reservationSummary = document.getElementById('reservationSummary');
  const reservationForm = document.getElementById('reservationForm');
  if (!reservationSummary || !reservationForm) return;

  reservationForm.style.display = 'none';
  reservationSummary.style.display = 'block';
  reservationSummary.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ========== 11. 内容を変更するボタン（確認画面 → 入力画面に戻る） ========== //
document.getElementById('editReservation').addEventListener('click', function () {
  document.getElementById('reservationSummary').style.display = 'none';
  document.getElementById('reservationForm').style.display = 'block';
});

// ========== 12. 予約確定・LINE送信 ========== //
document.getElementById('confirmReservation').addEventListener('click', function () {
  const agreeChecked = document.getElementById('agreeCheckbox').checked;
  if (!agreeChecked) {
    alert('同意事項に同意してください');
    return;
  }

  let message = 'ご予約希望メッセージ\n';
  if (reservationData.username) message += `\n予約者名: ${reservationData.username}様\n`;
  if (reservationData.furigana) message += `フリガナ: ${reservationData.furigana}様\n`;
  if (reservationData.gender) message += `性別: ${reservationData.gender}\n`;
  if (reservationData.phone) message += `電話番号: ${reservationData.phone}\n`;
  if (reservationData.menu) message += `メニュー: ${reservationData.menu}\n`;
  if (reservationData.stylist) message += `スタイリスト: ${reservationData.stylist}\n`;

  if (Array.isArray(reservationData.preferences) && reservationData.preferences.length > 0) {
    message += `希望日時:\n${reservationData.preferences.map((pref, index) => {
      return `第${index + 1}希望: ${pref.date} ${pref.time}`;
    }).join('\n')}`;
  }

  if (reservationData.comments) message += `備考: ${reservationData.comments}\n`;

  message += `\n\nご記入いただきありがとうございます！\nただいま確認いたしますのでお待ちください！🙏⏳`;

  console.log('送信するメッセージ:', message);

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


