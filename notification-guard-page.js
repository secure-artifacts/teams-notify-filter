/**
 * 页面主世界：拦截 Teams 使用的原生 Notification API。
 */
(function () {
  if (window.__teamsNotifyGuardInstalled) return;
  window.__teamsNotifyGuardInstalled = true;

  const NativeNotification = window.Notification;
  if (!NativeNotification) return;

  let blockNative = true;

  window.addEventListener("teams-notify-config", (event) => {
    blockNative = event.detail?.enabled !== false;
  });

  function noopNotification(title, options) {
    const stub = {
      title: String(title || ""),
      body: String(options?.body || ""),
      tag: String(options?.tag || ""),
      data: options?.data ?? null,
      close: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      onclick: null,
      onshow: null,
      onerror: null,
      onclose: null,
    };
    queueMicrotask(() => stub.onshow?.(new Event("show")));
    return stub;
  }

  function FilteredNotification(title, options) {
    if (blockNative) {
      return noopNotification(title, options);
    }
    return new NativeNotification(title, options);
  }

  FilteredNotification.prototype = NativeNotification.prototype;
  Object.defineProperty(FilteredNotification, "permission", {
    get: () => NativeNotification.permission,
    configurable: true,
  });
  FilteredNotification.requestPermission = NativeNotification.requestPermission.bind(NativeNotification);

  window.Notification = FilteredNotification;
})();
