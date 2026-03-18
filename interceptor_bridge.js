window.addEventListener("message", (e) => {
  if (e.data?.__certkeeper && e.data.type === "response") {
    chrome.runtime.sendMessage({
      action: "responseBody",
      url: e.data.url,
      status: e.data.status,
      body: e.data.body,
    }).catch(() => {});
  }
});
