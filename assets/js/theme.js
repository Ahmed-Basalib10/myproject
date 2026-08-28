// Light/dark theme toggle. Initial theme is applied inline in <head> (see
// each page's inline script) to avoid a flash of the wrong theme before this
// file loads; this script only wires up the toggle button.
(function () {
  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const btn = document.querySelector('[data-theme-toggle]');
    if (!btn) return;
    const icon = btn.querySelector('[data-theme-icon]');
    if (icon) icon.textContent = theme === 'dark' ? '☀' : '☾';
    btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  }

  document.addEventListener('DOMContentLoaded', function () {
    const btn = document.querySelector('[data-theme-toggle]');
    if (!btn) return;
    apply(document.documentElement.getAttribute('data-theme') || 'light');
    btn.addEventListener('click', function () {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('theme', next); } catch (e) {}
      apply(next);
    });
  });
})();
