(function () {
  function getPreferences() {
    return ["1", "2", "3"]
      .map((num) => {
        const date = document.getElementById(`day${num}`)?.value || "";
        const time = document.getElementById(`time${num}`)?.value || "";
        return { index: num, date, time };
      })
      .filter((p) => p.date && p.time);
  }

  function collectReservationData() {
    const customer = window.CustomerStorage?.getCustomer() || {};
    const menu = document.getElementById("menu")?.value.trim() || "";
    const customerStatus = window.AppState?.customerStatus || localStorage.getItem("customerStatus") || "新規";

    return {
      customer,
      customerStatus,
      menu,
      stylist: document.getElementById("selectedStylistInput")?.value.trim() || "",
      preferences: getPreferences(),
      comments: document.getElementById("comments")?.value.trim() || "",
    };
  }

  function buildSummaryHtml(data) {
    let prefsHtml = data.preferences
      .map((p, i) => `<tr><th>第${i + 1}希望</th><td>${p.date} ${p.time}</td></tr>`)
      .join("");

    return `
      <table class="summary-table">
        <tbody>
          <tr><th>予約者名</th><td>${data.customer.username || "未登録"}</td></tr>
          <tr><th>フリガナ</th><td>${data.customer.furigana || "未登録"}</td></tr>
          <tr><th>性別</th><td>${data.customer.gender || "未登録"}</td></tr>
          <tr><th>ステータス</th><td>${data.customerStatus || "新規"}</td></tr>
          <tr><th>電話番号</th><td>${data.customer.phoneNumber || "未登録"}</td></tr>
          <tr><th>メニュー</th><td>${data.menu || "未入力"}</td></tr>
          <tr><th>担当者</th><td>${data.stylist || "未選択"}</td></tr>
          ${prefsHtml}
          <tr><th>備考</th><td>${data.comments || "なし"}</td></tr>
        </tbody>
      </table>
    `;
  }

  function buildLineMessage(data) {
    return [
      "予約希望メッセージ",
      `予約者名: ${data.customer.username || "未登録"}`,
      `フリガナ: ${data.customer.furigana || "未登録"}`,
      `性別: ${data.customer.gender || "未登録"}`,
      `ステータス: ${data.customerStatus || "新規"}`,
      `電話番号: ${data.customer.phoneNumber || "未登録"}`,
      `メニュー: ${data.menu || "未入力"}`,
      `担当スタイリスト: ${data.stylist || "未選択"}`,
      ...data.preferences.map((p, i) => `第${i + 1}希望: ${p.date} ${p.time}`),
      `備考: ${data.comments || "なし"}`,
      "",
      "ご予約希望ありがとうございます。",
      "確認いたしますのでお待ちください。",
    ].join("\n");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const submitReservationBtn = document.getElementById("submitReservation");
    const editReservationBtn = document.getElementById("editReservation");
    const submitBtn = document.getElementById("submitbtn");

    const reservationForm = document.getElementById("reservationForm");
    const reservationSummary = document.getElementById("reservationSummary");
    const summaryDetails = document.getElementById("summaryDetails");
    const summaryScrollHint = document.getElementById("summaryScrollHint");
    const formArea = document.getElementById("formArea");

    let latestReservationData = null;
    let isSubmitButtonVisible = false;

    function setSummaryHintVisible(visible) {
      if (!summaryScrollHint) return;
      summaryScrollHint.classList.toggle("is-visible", visible);
    }

    function isSummaryMode() {
      return reservationSummary && reservationSummary.style.display === "block";
    }

    function refreshSummaryHint() {
      setSummaryHintVisible(Boolean(isSummaryMode() && !isSubmitButtonVisible));
    }

    const submitBtnObserver =
      typeof IntersectionObserver !== "undefined" && submitBtn
        ? new IntersectionObserver(
            (entries) => {
              const [entry] = entries;
              isSubmitButtonVisible = Boolean(entry?.isIntersecting);
              refreshSummaryHint();
            },
            {
              root: null,
              threshold: 0.15,
            }
          )
        : null;

    if (submitBtnObserver && submitBtn) {
      submitBtnObserver.observe(submitBtn);
    } else {
      const fallbackCheck = () => {
        if (!submitBtn) return;
        const rect = submitBtn.getBoundingClientRect();
        isSubmitButtonVisible = rect.top < window.innerHeight && rect.bottom > 0;
        refreshSummaryHint();
      };
      window.addEventListener("scroll", fallbackCheck, { passive: true });
      window.addEventListener("resize", fallbackCheck);
      fallbackCheck();
    }

    submitReservationBtn?.addEventListener("click", (event) => {
      event.preventDefault();

      const customer = window.CustomerStorage?.getCustomer();
      if (!customer?.username || !customer?.furigana || !customer?.gender || !customer?.phoneNumber) {
        alert("顧客情報が見つかりません。先に顧客情報を登録してください。");
        return;
      }

      if (!window.FormValidator?.validateReservationForm()) return;

      latestReservationData = collectReservationData();

      if (summaryDetails) {
        summaryDetails.innerHTML = buildSummaryHtml(latestReservationData);
      }

      if (reservationForm) reservationForm.style.display = "none";
      if (reservationSummary) reservationSummary.style.display = "block";

      formArea?.scrollIntoView({ behavior: "smooth", block: "start" });
      refreshSummaryHint();
    });

    editReservationBtn?.addEventListener("click", () => {
      if (reservationSummary) reservationSummary.style.display = "none";
      if (reservationForm) reservationForm.style.display = "block";
      refreshSummaryHint();
    });

    submitBtn?.addEventListener("click", () => {
      const agreeChecked = document.getElementById("agreeCheckbox")?.checked;
      if (!agreeChecked) {
        alert("送信ができていません。同意事項をチェックしてください。");
        return;
      }

      if (!latestReservationData) {
        alert("予約内容を確認してから送信してください。");
        return;
      }

      const message = buildLineMessage(latestReservationData);

      if (!window.liff || typeof liff.sendMessages !== "function") {
        alert("LINE送信機能が利用できません。環境を確認してください。");
        return;
      }

      liff
        .sendMessages([{ type: "text", text: message }])
        .then(() => {
          alert("予約内容を送信しました。");
          setSummaryHintVisible(false);
          if (typeof liff.closeWindow === "function") {
            liff.closeWindow();
          }
        })
        .catch((error) => {
          alert(`送信エラー: ${error.message}`);
        });
    });

    refreshSummaryHint();
  });
})();
