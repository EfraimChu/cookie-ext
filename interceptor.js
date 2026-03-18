(() => {
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const resp = await origFetch.apply(this, args);
    try {
      const clone = resp.clone();
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const body = await clone.text();
      window.postMessage({ __certkeeper: true, type: "response", url, status: clone.status, body }, "*");
    } catch (_) {}
    return resp;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ck_url = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      try {
        window.postMessage({
          __certkeeper: true, type: "response",
          url: this.__ck_url, status: this.status, body: this.responseText,
        }, "*");
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };
})();
