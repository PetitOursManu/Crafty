// Thème appliqué avant le premier affichage (script classique dans <head>, pas de flash).
// Choix : 'light' (défaut), 'dark' ou 'system'. Mémorisé dans ce navigateur, synchronisé avec le compte par ui.js.
(function () {
  var KEY = 'craft-theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function read() { try { return localStorage.getItem(KEY) || 'light'; } catch (e) { return 'light'; } }
  function apply(choice) {
    var dark = choice === 'dark' || (choice === 'system' && mq && mq.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme-choice', choice);
  }
  apply(read());
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (read() === 'system') apply('system'); });
  window.craftTheme = {
    get: read,
    set: function (choice) {
      try { localStorage.setItem(KEY, choice); } catch (e) {}
      apply(choice);
      window.dispatchEvent(new CustomEvent('craft-theme-change', { detail: choice }));
    },
  };
})();
