(function () {
  function setError(fieldId, message) {
    const errorEl = document.getElementById(`${fieldId}Error`);
    const fieldEl = document.getElementById(fieldId);
    if (errorEl) errorEl.textContent = message || "";
    if (fieldEl) fieldEl.classList.toggle("error-field", Boolean(message));
  }

  function setCustomError(errorId, message, targetId) {
    const errorEl = document.getElementById(errorId);
    const fieldEl = document.getElementById(targetId);
    if (errorEl) errorEl.textContent = message || "";
    if (fieldEl) fieldEl.classList.toggle("error-field", Boolean(message));
  }

  function clearCustomerErrors() {
    ["username", "furigana", "gender", "phoneNumber"].forEach((id) => setError(id, ""));
  }

  function validateCustomerForm() {
    clearCustomerErrors();

    const username = document.getElementById("username")?.value.trim() || "";
    const furigana = document.getElementById("furigana")?.value.trim() || "";
    const gender = document.querySelector('input[name="gender"]:checked')?.value || "";
    const phoneNumber = document.getElementById("phoneNumber")?.value.trim() || "";

    let isValid = true;

    if (!username) {
      setError("username", "予約者名を入力してください");
      isValid = false;
    }

    if (!furigana) {
      setError("furigana", "フリガナを入力してください");
      isValid = false;
    }

    if (!gender) {
      const genderError = document.getElementById("genderError");
      if (genderError) genderError.textContent = "性別を選択してください";
      isValid = false;
    } else {
      const genderError = document.getElementById("genderError");
      if (genderError) genderError.textContent = "";
    }

    if (!/^0\d{1,4}-?(\d{1,4}){1,2}-?\d{4}$/.test(phoneNumber)) {
      setError("phoneNumber", "電話番号の形式が正しくありません");
      isValid = false;
    }

    if (!isValid) {
      alert("顧客情報の入力内容を確認してください。");
    }

    return isValid;
  }

  function validateReservationForm() {
    setCustomError("menuError", "", "menu");
    setCustomError("stylistError", "", "stylist-container");

    const menu = document.getElementById("menu")?.value.trim() || "";
    const selectedStylist = document.getElementById("selectedStylistInput")?.value.trim() || "";
    const day1 = document.getElementById("day1")?.value || "";
    const time1 = document.getElementById("time1")?.value || "";

    let isValid = true;
    let firstInvalidElement = null;

    if (!day1 || !time1) {
      alert("第1希望の日程を選択してください。");
      isValid = false;
      firstInvalidElement = firstInvalidElement || document.querySelector('.calendar-picker[data-for="day1"]') || document.getElementById("day1");
    }

    if (!menu) {
      setCustomError("menuError", "メニューを入力してください", "menu");
      isValid = false;
      firstInvalidElement = firstInvalidElement || document.getElementById("menuSectionTitle") || document.getElementById("menu");
    }

    if (!selectedStylist) {
      setCustomError("stylistError", "担当スタイリストを選択してください", "stylist-container");
      isValid = false;
      firstInvalidElement = firstInvalidElement || document.getElementById("stylistSectionTitle") || document.getElementById("stylist-container");
    }

    if (!isValid) {
      alert("予約情報の入力内容を確認してください。");
      firstInvalidElement?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    return isValid;
  }

  window.FormValidator = {
    validateCustomerForm,
    validateReservationForm,
  };
})();

