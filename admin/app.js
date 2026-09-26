const loginView = document.getElementById("login-view");
const editorView = document.getElementById("editor-view");
const clerkSignIn = document.getElementById("clerk-sign-in");
const clerkUserButton = document.getElementById("clerk-user-button");
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
const previewStage = document.getElementById("preview-stage");
const saveState = document.getElementById("save-state");
const providerLabel = document.getElementById("provider-label");

let state = {
  draft: null,
  history: [],
  conversation: [],
  busy: false,
};
let currentPreviewPath = "index.html";

async function api(path, options = {}) {
  const token = window.Clerk?.session ? await window.Clerk.session.getToken() : null;
  const response = await fetch(`/api/editor/${path}`, {
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
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
    const copy = document.createElement("div");
    copy.textContent = text;
    message.append(copy);
    if (options.receipt) {
      const receipt = document.createElement("div");
      receipt.className = `change-receipt${options.undone ? " is-undone" : ""}`;
      const summary = document.createElement("strong");
      const count = options.receipt.files.length;
      summary.textContent = options.undone
        ? "Change undone"
        : `${count} file${count === 1 ? "" : "s"} changed`;
      const paths = document.createElement("span");
      paths.textContent = options.receipt.files.join(" · ");
      receipt.append(summary, paths);
      if (options.canUndo) {
        const undoButton = document.createElement("button");
        undoButton.type = "button";
        undoButton.className = "receipt-undo";
        undoButton.textContent = "Undo";
        undoButton.addEventListener("click", undoLatestEdit);
        receipt.append(undoButton);
      }
      message.append(receipt);
    }
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
  state.conversation.forEach(item => addMessage(item.role === "user" ? "user" : "assistant", item.text, {
    receipt: item.receipt,
    undone: item.undone,
    canUndo: Boolean(item.editId && item.editId === state.draft?.lastEditId && state.draft?.canUndo && !item.undone),
  }));
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

function refreshPreview(path = currentPreviewPath) {
  currentPreviewPath = path || "index.html";
  previewFrame.src = `/preview/${currentPreviewPath}?t=${Date.now()}`;
}

async function undoLatestEdit(event) {
  const button = event?.currentTarget;
  if (button) {
    button.disabled = true;
  }
  try {
    const data = await api("undo", { method: "POST", body: "{}" });
    state.draft = data.draft;
    state.conversation = data.conversation;
    renderConversation();
    renderDraftState();
    refreshPreview(data.previewPath);
  } catch (error) {
    addMessage("assistant", error.message, { error: true });
  }
}

async function loadStatus() {
  // Never let a status refresh overwrite the conversation while a message is
  // actively in flight - it would wipe the optimistic "user message + typing
  // bubble" UI with stale server state that doesn't include it yet.
  if (state.busy) {
    return;
  }
  try {
    const data = await api("status", { method: "GET" });
    state = { ...state, ...data };
    providerLabel.textContent = data.aiModel ? `${data.aiProvider} · ${data.aiModel}` : data.aiProvider;
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

// Clerk's SignIn component is mounted at most once, and ONLY when there is
// no active session - never unconditionally on every page load. The
// infinite reload loop we hit twice was caused by mounting SignIn (with a
// forced post-sign-in redirect) even for an already-authenticated visitor:
// on mount, it would notice the existing session, immediately fire its
// "redirect now" behavior to the same page, causing a full reload, which
// mounted SignIn again, which redirected again - forever. Only mounting it
// for a genuinely signed-out visitor removes the condition that triggers
// that loop, so it's safe to tell Clerk exactly where to land afterward.
let signInMounted = false;
function mountSignInIfNeeded() {
  if (signInMounted) {
    return;
  }
  signInMounted = true;
  window.Clerk.mountSignIn(clerkSignIn, { forceRedirectUrl: "/admin/" });
}

async function initAuth() {
  await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
  // "Manage account" here is where a user can add a password to an account
  // that was originally created without one (e.g. via a since-disabled OAuth
  // sign-in), so future sign-ins don't require a fresh email code every time.
  window.Clerk.mountUserButton(clerkUserButton);
  // Clerk fires this listener repeatedly in the background as it silently
  // refreshes the session token (not just on an actual sign-in/out). Only
  // call loadStatus() on a genuine signed-out -> signed-in transition - it
  // wipes and rebuilds the whole conversation from the server's last-saved
  // state, so calling it on every background refresh could wipe an in-flight
  // chat message before the server has finished saving it.
  let wasSignedIn = Boolean(window.Clerk.user);
  window.Clerk.addListener(({ user }) => {
    const isSignedIn = Boolean(user);
    if (isSignedIn && !wasSignedIn) {
      setAuthenticated(true);
      loadStatus();
    } else if (!isSignedIn) {
      setAuthenticated(false);
      mountSignInIfNeeded();
    }
    wasSignedIn = isSignedIn;
  });
  if (window.Clerk.user) {
    setAuthenticated(true);
    loadStatus();
  } else {
    setAuthenticated(false);
    mountSignInIfNeeded();
  }
}

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
    addMessage("assistant", data.message, { receipt: data.receipt, canUndo: true });
    if (data.receipt.aiProvider) {
      providerLabel.textContent = data.receipt.usedFallback
        ? `Backup used · ${data.receipt.aiProvider} · ${data.receipt.aiModel}`
        : `${data.receipt.aiProvider} · ${data.receipt.aiModel}`;
    }
    state.draft = data.draft;
    state.conversation.push(
      { role: "user", text: message },
      { role: "assistant", text: data.message, editId: data.draft.lastEditId, receipt: data.receipt }
    );
    refreshPreview(data.receipt.previewPath);
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
document.getElementById("refresh-preview").addEventListener("click", () => refreshPreview());
document.getElementById("desktop-size").addEventListener("click", () => setPreviewSize("desktop"));
document.getElementById("phone-size").addEventListener("click", () => setPreviewSize("phone"));

function setPreviewSize(size) {
  const phone = size === "phone";
  previewStage.classList.toggle("is-phone", phone);
  document.getElementById("desktop-size").classList.toggle("is-active", !phone);
  document.getElementById("desktop-size").setAttribute("aria-pressed", String(!phone));
  document.getElementById("phone-size").classList.toggle("is-active", phone);
  document.getElementById("phone-size").setAttribute("aria-pressed", String(phone));
}

document.getElementById("mobile-preview").addEventListener("click", () => {
  document.body.classList.add("show-preview");
  refreshPreview();
});
document.getElementById("close-preview").addEventListener("click", () => document.body.classList.remove("show-preview"));

window.addEventListener("load", () => {
  initAuth();
});