// Live Asia/Riyadh clock for the hero's date/time line (#live-clock).
// Distinct from "آخر تحديث" (last update) further down the page, which is a
// baked timestamp of when prices were last polled — this ticks real time,
// independent of the visitor's own timezone/locale, in Arabic.
(function () {
  const ARABIC_WEEKDAYS = {
    Sunday: 'الأحد', Monday: 'الاثنين', Tuesday: 'الثلاثاء', Wednesday: 'الأربعاء',
    Thursday: 'الخميس', Friday: 'الجمعة', Saturday: 'السبت'
  };

  const ARABIC_MONTHS = {
    January: 'يناير', February: 'فبراير', March: 'مارس', April: 'أبريل',
    May: 'مايو', June: 'يونيو', July: 'يوليو', August: 'أغسطس',
    September: 'سبتمبر', October: 'أكتوبر', November: 'نوفمبر', December: 'ديسمبر'
  };

  // en-US keeps digits Western and part types predictable; Arabic labels are
  // substituted from the maps above so the string still reads as Arabic.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Riyadh',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  function riyadhNowParts() {
    const parts = {};
    for (const part of formatter.formatToParts(new Date())) {
      parts[part.type] = part.value;
    }
    return parts;
  }

  function renderClock() {
    const el = document.getElementById('live-clock');
    if (!el) return;
    const p = riyadhNowParts();
    const weekday = ARABIC_WEEKDAYS[p.weekday] || p.weekday;
    const month = ARABIC_MONTHS[p.month] || p.month;
    const ampm = p.dayPeriod === 'PM' ? 'م' : 'ص';
    const minute = p.minute.length < 2 ? '0' + p.minute : p.minute;
    el.innerHTML = weekday + ' ' + p.day + ' ' + month + ' ' + p.year +
      ' — <span class="ltr">' + p.hour + ':' + minute + '</span> ' + ampm;
  }

  document.addEventListener('DOMContentLoaded', function () {
    renderClock();
    setInterval(renderClock, 30 * 1000);
  });
})();
