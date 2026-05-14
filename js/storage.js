(function () {
  const STORAGE_KEY = "oasis_customer_info";

  function getCustomer() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.error("Failed to parse customer info", error);
      return null;
    }
  }

  function saveCustomer(customer) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(customer));
  }

  function clearCustomer() {
    localStorage.removeItem(STORAGE_KEY);
  }

  window.CustomerStorage = {
    getCustomer,
    saveCustomer,
    clearCustomer,
  };
})();

