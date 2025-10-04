import type { Status } from "#/db";
import { html } from "../lib/view";
import { shell } from "./shell";

type Props = {
  profile?: { displayName?: string; handle?: string };
  isWaiting?: boolean;
  partner?: { displayName?: string; handle?: string; typing?: string };
  myTyping?: string;
};

export function home(props: Props) {
  return shell({
    title: "Saloon",
    content: content(props),
  });
}

function content({ profile, isWaiting, partner, myTyping }: Props) {
  return html`<div
    id="root"
    data-profile="${profile ? JSON.stringify(profile) : ""}"
  >
    <div class="error"></div>
    <div id="header">
      <h1>Saloon</h1>
      <p>Live typing chat with strangers</p>
    </div>
    <div class="container">
      ${profile
        ? html`<div class="chat-container">
            <div class="partner-area">
              <div class="partner-header">
                ${partner
                  ? html`<div class="partner-info">
                      <strong
                        >${partner.displayName ||
                        partner.handle ||
                        "Stranger"}</strong
                      >
                      <span class="handle"
                        >@${partner.handle || "unknown"}</span
                      >
                    </div>`
                  : html`<div class="waiting">
                      ${isWaiting
                        ? "Waiting for someone to chat with..."
                        : "Finding a chat partner..."}
                    </div>`}
                <form action="/logout" method="post" class="logout-form">
                  <button type="submit" class="logout-btn">Leave</button>
                </form>
              </div>
              <div class="partner-typing">${partner?.typing || ""}</div>
            </div>
            <div class="my-area">
              <div class="my-header">
                <div class="my-info">
                  <strong
                    >${profile.displayName || profile.handle || "You"}</strong
                  >
                  <span class="handle">@${profile.handle || "unknown"}</span>
                </div>
              </div>
              <div class="typing-container">
                <input
                  type="text"
                  id="typing-input"
                  placeholder="Type your message..."
                  value="${myTyping || ""}"
                  class="typing-input"
                />
                <div class="typing-indicator">
                  ${myTyping ? "Typing..." : ""}
                </div>
              </div>
            </div>
          </div>`
        : html`<div class="card">
            <div class="session-form">
              <div><a href="/login">Log in</a> to start chatting!</div>
              <div>
                <a href="/login" class="button">Log in</a>
              </div>
            </div>
          </div>`}
    </div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
      // Socket.IO client code
      const socket = io();

      // Session management
      function saveSession(profile, roomId = null, partner = null) {
        const sessionData = {
          profile,
          roomId,
          partner,
          timestamp: Date.now(),
        };
        localStorage.setItem("saloon-session", JSON.stringify(sessionData));
      }

      function loadSession() {
        try {
          const sessionData = localStorage.getItem("saloon-session");
          if (sessionData) {
            const session = JSON.parse(sessionData);
            // Check if session is not too old (24 hours)
            if (Date.now() - session.timestamp < 24 * 60 * 60 * 1000) {
              return session;
            }
          }
        } catch (e) {
          console.warn("Failed to load session:", e);
        }
        return null;
      }

      function clearSession() {
        localStorage.removeItem("saloon-session");
      }

      // Load session on page load
      const profileData = document
        .getElementById("root")
        .getAttribute("data-profile");
      const profile = profileData ? JSON.parse(profileData) : null;
      const savedSession = loadSession();

      if (profile) {
        // User is logged in, save session and join waiting room
        saveSession(profile);
        socket.emit("join-waiting", profile);
      } else if (savedSession && savedSession.profile) {
        // Restore session from localStorage
        console.log("Restoring session for:", savedSession.profile.handle);

        // Update the UI to show the restored session
        const partnerInfo = document.querySelector(".partner-info");
        const waiting = document.querySelector(".waiting");

        if (savedSession.partner) {
          // Restore partner info
          if (partnerInfo) {
            partnerInfo.innerHTML = \`
              <strong>\${savedSession.partner.displayName || savedSession.partner.handle || "Stranger"}</strong>
              <span class="handle">@\${savedSession.partner.handle || "unknown"}</span>
            \`;
            partnerInfo.style.display = "block";
          }
          if (waiting) {
            waiting.style.display = "none";
          }

          // Rejoin the room
          socket.emit("rejoin-room", {
            profile: savedSession.profile,
            roomId: savedSession.roomId,
            partner: savedSession.partner,
          });
        } else {
          // Rejoin waiting room
          if (waiting) {
            waiting.textContent = "Reconnecting...";
            waiting.style.display = "block";
          }
          if (partnerInfo) {
            partnerInfo.style.display = "none";
          }

          socket.emit("join-waiting", savedSession.profile);
        }
      }

      const typingInput = document.getElementById("typing-input");
      if (typingInput) {
        let typingTimeout;
        let currentMessage = "";

        typingInput.addEventListener("input", (e) => {
          const message = e.target.value;
          currentMessage = message;

          // Send typing update to server
          socket.emit("typing", message);

          // Clear previous timeout
          clearTimeout(typingTimeout);

          // Set new timeout to stop typing indicator (but keep the message)
          typingTimeout = setTimeout(() => {
            socket.emit("typing", "");
          }, 2000);
        });

        // Handle form submission
        typingInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && currentMessage.trim()) {
            e.preventDefault();

            // Send final message
            socket.emit("typing", currentMessage);

            // Clear input
            typingInput.value = "";
            currentMessage = "";

            // Send empty message to clear partner's view
            setTimeout(() => {
              socket.emit("typing", "");
            }, 100);

            // Add fade out effect to partner's view
            const partnerTyping = document.querySelector(".partner-typing");
            if (partnerTyping && partnerTyping.textContent) {
              partnerTyping.style.transition = "opacity 2s ease-out";
              partnerTyping.style.opacity = "0";
              setTimeout(() => {
                partnerTyping.textContent = "";
                partnerTyping.style.opacity = "1";
                partnerTyping.style.transition = "";
              }, 2000);
            }
          }
        });
      }

      // Listen for partner's typing
      socket.on("partner-typing", (message) => {
        const partnerTyping = document.querySelector(".partner-typing");
        if (partnerTyping) {
          if (message) {
            // Show message with fade in
            partnerTyping.style.transition = "opacity 0.3s ease-in";
            partnerTyping.style.opacity = "1";
            partnerTyping.textContent = message;
          } else {
            // Fade out and clear
            partnerTyping.style.transition = "opacity 2s ease-out";
            partnerTyping.style.opacity = "0";
            setTimeout(() => {
              partnerTyping.textContent = "";
              partnerTyping.style.opacity = "1";
              partnerTyping.style.transition = "";
            }, 2000);
          }
        }
      });

      // Listen for room updates
      socket.on("room-update", (data) => {
        if (data.partner) {
          // Update partner info
          const partnerInfo = document.querySelector(".partner-info");
          if (partnerInfo) {
            partnerInfo.innerHTML = \`
              <strong>\${data.partner.displayName || data.partner.handle || "Stranger"}</strong>
              <span class="handle">@\${data.partner.handle || "unknown"}</span>
            \`;
          }

          // Show partner info instead of waiting
          const waiting = document.querySelector(".waiting");
          if (waiting) {
            waiting.style.display = "none";
          }
          const partnerInfoContainer = document.querySelector(".partner-info");
          if (partnerInfoContainer) {
            partnerInfoContainer.style.display = "block";
          }

          // Save session with partner info
          const currentProfile =
            profile || (savedSession ? savedSession.profile : null);
          if (currentProfile) {
            saveSession(currentProfile, data.roomId, data.partner);
          }
        }

        if (data.isWaiting !== undefined) {
          const waiting = document.querySelector(".waiting");
          if (waiting) {
            waiting.textContent = data.isWaiting
              ? "Waiting for someone to chat with..."
              : "Finding a chat partner...";
            waiting.style.display = "block";
          }

          // Save session without partner (waiting state)
          const currentProfile =
            profile || (savedSession ? savedSession.profile : null);
          if (currentProfile) {
            saveSession(currentProfile);
          }
        }
      });

      // Handle partner leaving
      socket.on("partner-left", () => {
        // Show waiting state again
        const waiting = document.querySelector(".waiting");
        if (waiting) {
          waiting.textContent = "Your partner left. Finding someone new...";
          waiting.style.display = "block";
        }
        const partnerInfo = document.querySelector(".partner-info");
        if (partnerInfo) {
          partnerInfo.style.display = "none";
        }

        // Clear partner typing
        const partnerTyping = document.querySelector(".partner-typing");
        if (partnerTyping) {
          partnerTyping.textContent = "";
        }

        // Update session to remove partner
        const currentProfile =
          profile || (savedSession ? savedSession.profile : null);
        if (currentProfile) {
          saveSession(currentProfile); // Save without partner
        }

        // Rejoin waiting room
        if (currentProfile) {
          socket.emit("join-waiting", currentProfile);
        }
      });

      // Handle partner reconnection
      socket.on("partner-reconnected", (profile) => {
        const partnerTyping = document.querySelector(".partner-typing");
        if (partnerTyping) {
          partnerTyping.textContent =
            (profile.displayName || profile.handle || "Partner") +
            " reconnected";
          setTimeout(() => {
            partnerTyping.textContent = "";
          }, 3000);
        }
      });

      // Handle logout
      const logoutForm = document.querySelector('form[action="/logout"]');
      if (logoutForm) {
        logoutForm.addEventListener("submit", () => {
          clearSession();
        });
      }
    </script>
  </div>`;
}
