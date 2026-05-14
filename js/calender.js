(function () {
  const holidays = [];

  const specialWorkingDays = [];
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  const CALENDAR_CELL_COUNT = 42;
  const calendarStates = new Map();

  function formatDateLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseDateKey(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

  function sameMonth(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  }

  function generateDates(maxDays = 180) {
    const dates = [];
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    for (let i = 0; i < maxDays; i += 1) {
      const current = new Date(start);
      current.setDate(start.getDate() + i);

      const formatted = formatDateLocal(current);
      const day = current.getDay();
      const isClosed = day === 1 || day === 2 || holidays.includes(formatted);

      dates.push({
        date: formatted,
        weekday: dayNames[day],
        isWeekend: day === 0 || day === 6,
        isClosed,
      });
    }

    specialWorkingDays.forEach((date) => {
      if (!dates.some((d) => d.date === date)) {
        const d = new Date(date);
        const day = d.getDay();
        dates.push({
          date,
          weekday: dayNames[day],
          isWeekend: day === 0 || day === 6,
          isClosed: false,
        });
      } else {
        const target = dates.find((item) => item.date === date);
        if (target) target.isClosed = false;
      }
    });

    return dates.sort((a, b) => new Date(a.date) - new Date(b.date));
  }

  function buildAvailabilityMap(dates) {
    const map = new Map();
    dates.forEach((d) => map.set(d.date, d));
    return map;
  }

  function getGridStartDate(monthDate) {
    const firstDayOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const start = new Date(firstDayOfMonth);
    start.setDate(firstDayOfMonth.getDate() - firstDayOfMonth.getDay());
    return start;
  }

  function buildCalendarDom(select) {
    const wrapper = document.createElement("div");
    wrapper.className = "calendar-picker";
    wrapper.dataset.for = select.id;

    wrapper.innerHTML = `
      <div class="calendar-picker__header">
        <button type="button" class="calendar-picker__nav" data-role="prev" aria-label="前月">&#x2039;</button>
        <p class="calendar-picker__month" data-role="month"></p>
        <button type="button" class="calendar-picker__nav" data-role="next" aria-label="次月">&#x203A;</button>
      </div>
      <div class="calendar-picker__weekdays">
        <span class="sun">日</span>
        <span>月</span>
        <span>火</span>
        <span>水</span>
        <span>木</span>
        <span>金</span>
        <span class="sat">土</span>
      </div>
      <div class="calendar-picker__grid" data-role="grid"></div>
    `;

    select.parentNode.insertBefore(wrapper, select);
    return wrapper;
  }

  function renderCalendar(selectId) {
    const state = calendarStates.get(selectId);
    if (!state) return;

    const {
      select,
      availabilityMap,
      minDate,
      maxDate,
      monthLabel,
      grid,
      prevBtn,
      nextBtn,
      currentMonth,
    } = state;

    monthLabel.textContent = `${currentMonth.getFullYear()}年 ${currentMonth.getMonth() + 1}月`;
    grid.innerHTML = "";

    const gridStart = getGridStartDate(currentMonth);

    for (let i = 0; i < CALENDAR_CELL_COUNT; i += 1) {
      const cellDate = new Date(gridStart);
      cellDate.setDate(gridStart.getDate() + i);

      const key = formatDateLocal(cellDate);
      const data = availabilityMap.get(key);
      const inMonth = sameMonth(cellDate, currentMonth);
      const isClosed = !data || data.isClosed;
      const isSelected = select.value === key;

      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "calendar-picker__day";
      if (!inMonth) cell.classList.add("outside");
      if (cellDate.getDay() === 0) cell.classList.add("sun");
      if (cellDate.getDay() === 6) cell.classList.add("sat");
      if (isClosed) cell.classList.add("closed");
      if (isSelected) cell.classList.add("selected");

      cell.textContent = String(cellDate.getDate());
      cell.disabled = isClosed;

      if (!isClosed) {
        cell.addEventListener("click", () => {
          state.select.value = key;
          renderCalendar(selectId);
        });
      }

      grid.appendChild(cell);
    }

    const prevMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    const nextMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1);
    prevBtn.disabled = prevMonth < new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    nextBtn.disabled = nextMonth > new Date(maxDate.getFullYear(), maxDate.getMonth(), 1);
  }

  function ensureCalendarForSelect(select, dates) {
    const firstAvailable = dates.find((d) => !d.isClosed);
    if (firstAvailable) {
      select.value = firstAvailable.date;
    }

    let wrapper = select.parentElement?.querySelector(`.calendar-picker[data-for="${select.id}"]`);
    if (!wrapper) {
      wrapper = buildCalendarDom(select);
    }

    const monthLabel = wrapper.querySelector('[data-role="month"]');
    const grid = wrapper.querySelector('[data-role="grid"]');
    const prevBtn = wrapper.querySelector('[data-role="prev"]');
    const nextBtn = wrapper.querySelector('[data-role="next"]');

    if (!monthLabel || !grid || !prevBtn || !nextBtn) return;

    const availabilityMap = buildAvailabilityMap(dates);
    const minDate = parseDateKey(dates[0].date);
    const maxDate = parseDateKey(dates[dates.length - 1].date);
    const selectedDate = select.value ? parseDateKey(select.value) : minDate;

    const existing = calendarStates.get(select.id);
    const state = {
      select,
      availabilityMap,
      minDate,
      maxDate,
      monthLabel,
      grid,
      prevBtn,
      nextBtn,
      currentMonth: existing?.currentMonth || new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1),
    };

    calendarStates.set(select.id, state);

    if (!prevBtn.dataset.bound) {
      prevBtn.dataset.bound = "1";
      prevBtn.addEventListener("click", () => {
        const s = calendarStates.get(select.id);
        if (!s) return;
        const month = new Date(s.currentMonth.getFullYear(), s.currentMonth.getMonth() - 1, 1);
        const minMonth = new Date(s.minDate.getFullYear(), s.minDate.getMonth(), 1);
        if (month < minMonth) return;
        s.currentMonth = month;
        renderCalendar(select.id);
      });
    }

    if (!nextBtn.dataset.bound) {
      nextBtn.dataset.bound = "1";
      nextBtn.addEventListener("click", () => {
        const s = calendarStates.get(select.id);
        if (!s) return;
        const month = new Date(s.currentMonth.getFullYear(), s.currentMonth.getMonth() + 1, 1);
        const maxMonth = new Date(s.maxDate.getFullYear(), s.maxDate.getMonth(), 1);
        if (month > maxMonth) return;
        s.currentMonth = month;
        renderCalendar(select.id);
      });
    }

    renderCalendar(select.id);
  }

  function populateDateOptions(selectId) {
    const select = document.getElementById(selectId);
    if (!select) return;

    const dates = generateDates();
    select.innerHTML = "";

    dates.forEach((d) => {
      const option = document.createElement("option");
      option.value = d.date;
      option.textContent = d.isClosed ? `${d.date} (${d.weekday}) 休業日` : `${d.date} (${d.weekday})`;
      if (d.isWeekend) option.classList.add("red-day");
      if (d.isClosed) {
        option.disabled = true;
        option.classList.add("closed-day");
      }
      select.appendChild(option);
    });

    ensureCalendarForSelect(select, dates);
  }

  window.populateDateOptions = populateDateOptions;
})();
