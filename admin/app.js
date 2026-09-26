const loginView = document.getElementById("login-view");
const editorView = document.getElementById("editor-view");
const loginForm = document.getElementById("login-form");
const loginError = document.getElementById("login-error");
const chatForm = document.getElementById("chat-form");
const messageInput = document.getElementById("message");
const sendButton = document.getElementById("send-button");
const conversationElement = document.getElementById("conversation");
const suggestions = document.getElementById("suggestions");
const publishButton = document.getElementById("publish-button");
const discardButton = document.getElementById("discard-button");
const versionsButton = document.getElementById("versions-button");
const versionsDialog = document.getElementById("versions-dialog");
const versionList = document.getElementById("version-list");
const confirmDialog = document.getElementById("confirm-dialog");
const previewFrame = document.getElementById("preview-frame");
const saveState = document.getElementById("save-state");
const providerLabel = document.getElementById("provider-label");

let state = {
  draft: null,
  history: [],
  conversation: [],
  busy: false,
};

async function api(path, options = {}) {
  const response = await fetch(`/api/editor/${path}`, {
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Something went wrong.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function setAuthenticated(authenticated) {
  loginView.hidden = authenticated;
  editorView.hidden = !authenticated;
  if (authenticated) {
    messageInput.focus();
  }
}

function addMessage(role, text, options = {}) {
  const empty = conversationElement.querySelector(".empty-conversation");
  if (empty) {
    empty.remove();
  }
  const message = document.createElement("div");
  message.className = `message message-${role}${options.error ? " message-error" : ""}`;
  if (options.typing) {
    message.dataset.typing = "true";
    message.innerHTML = '<span class="typing" aria-label="Working"><span></span><span></span><span></span></span>';
  } else {
    message.textContent = text;
  }
  conversationElement.append(message);
  conversationElement.scrollTop = conversationElement.scrollHeight;
  return message;
}

function renderConversation() {
  conversationElement.replaceChildren();
  if (!state.conversation.length) {
    const empty = document.createElement("div");
    empty.className = "empty-conversation";
    empty.innerHTML = "<h2>What should we change?</h2><p>Ask in your own words. Nothing goes live until you press Publish changes.</p>";
    conversationElement.append(empty);
    return;
  }
  state.conversation.forEach(item => addMessage(item.role === "user" ? "user" : "assistant", item.text));
}

function renderDraftState() {
  const hasDraft = Boolean(state.draft);
  publishButton.disabled = !hasDraft || state.busy;
  discardButton.disabled = !hasDraft || state.busy;
  saveState.textContent = hasDraft ? "Previewing changes" : "Website is live";
  saveState.style.color = hasDraft ? "#b8442d" : "#2e6b45";
}

function renderVersions() {
  versionList.replaceChildren();
  if (!state.history.length) {
    const empty = document.createElement("p");
    empty.textContent = "No earlier versions yet.";
    versionList.append(empty);
    return;
  }
  state.history.forEach(version => {
    const row = document.createElement("div");
    row.className = "version-row";
    const copy = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = new Date(version.createdAt).toLocaleString();
    const description = document.createElement("p");
    description.textContent = version.description;
    copy.append(strong, description);
    const button = document.createElement("button");
    button.className = "secondary-button";
    button.type = "button";
    button.textContent = "Restore";
    button.addEventListener("click", () => restoreVersion(version.id));
    row.append(copy, button);
    versionList.append(row);
  });
}

function refreshPreview() {
  previewFrame.src = `/preview/index.html?t=${Date.now()}`;
}

async function loadStatus() {
  try {
    const data = await api("status", { method: "GET" });
    state = { ...state, ...data };
    providerLabel.textContent = data.aiProvider;
    setAuthenticated(true);
    renderConversation();
    renderDraftState();
    renderVersions();
    refreshPreview();
  } catch (error) {
    if (error.status === 401) {
      setAuthenticated(false);
      return;
    }
    loginError.textContent = error.message;
  }
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();
  loginError.textContent = "";
  const submitButton = loginForm.querySelector("button[type=submit]");
  submitButton.disabled = true;
  try {
    await api("login", {
      method: "POST",
      body: JSON.stringify({ password: loginForm.password.value }),
    });
    loginForm.reset();
    await loadStatus();
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
});

chatForm.addEventListener("submit", async event => {
  event.preventDefault();
  const message = messageInput.value.trim();
  if (!message || state.busy) {
    return;
  }

  state.busy = true;
  messageInput.value = "";
  sendButton.disabled = true;
  suggestions.hidden = true;
  addMessage("user", message);
  const typing = addMessage("assistant", "", { typing: true });
  renderDraftState();

  try {
    const data = await api("chat", { method: "POST", body: JSON.stringify({ message }) });
    typing.remove();
    addMessage("assistant", data.message);
    state.draft = data.draft;
    state.conversation.push({ role: "user", text: message }, { role: "assistant", text: data.message });
    refreshPreview();
  } catch (error) {
    typing.remove();
    addMessage("assistant", error.message, { error: true });
  } finally {
    state.busy = false;
    sendButton.disabled = false;
    renderDraftState();
    messageInput.focus();
  }
});

messageInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

suggestions.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }
  messageInput.value = button.textContent;
  messageInput.focus();
});

publishButton.addEventListener("click", () => confirmDialog.showModal());
document.getElementById("cancel-publish").addEventListener("click", () => confirmDialog.close());
document.getElementById("confirm-publish").addEventListener("click", async () => {
  const button = document.getElementById("confirm-publish");
  button.disabled = true;
  try {
    const data = await api("publish", { method: "POST", body: "{}" });
    confirmDialog.close();
    state.draft = null;
    addMessage("assistant", data.message);
    await loadStatus();
  } catch (error) {
    confirmDialog.close();
    addMessage("assistant", error.message, { error: true });
  } finally {
    button.disabled = false;
  }
});

discardButton.addEventListener("click", async () => {
  if (!window.confirm("Discard the changes in the preview?")) {
    return;
  }
  try {
    await api("discard", { method: "POST", body: "{}" });
    state.draft = null;
    addMessage("assistant", "I discarded those unpublished changes.");
    renderDraftState();
    refreshPreview();
  } catch (error) {
    addMessage("assistant", error.message, { error: true });
  }
});

async function restoreVersion(revisionId) {
  if (!window.confirm("Restore this earlier version to the live website?")) {
    return;
  }
  try {
    const data = await api("rollback", {
      method: "POST",
      body: JSON.stringify({ revisionId }),
    });
    versionsDialog.close();
    state.draft = null;
    addMessage("assistant", data.message);
    await loadStatus();
  } catch (error) {
    addMessage("assistant", error.message, { error: true });
  }
}

versionsButton.addEventListener("click", () => {
  renderVersions();
  versionsDialog.showModal();
});
document.getElementById("close-versions").addEventListener("click", () => versionsDialog.close());
document.getElementById("refresh-preview").addEventListener("click", refreshPreview);
document.getElementById("mobile-preview").addEventListener("click", () => {
  document.body.classList.add("show-preview");
  refreshPreview();
});
document.getElementById("close-preview").addEventListener("click", () => document.body.classList.remove("show-preview"));
document.getElementById("logout-button").addEventListener("click", async () => {
  await api("logout", { method: "POST", body: "{}" });
  setAuthenticated(false);
});

loadStatus();