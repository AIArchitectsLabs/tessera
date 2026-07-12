document.addEventListener("DOMContentLoaded", () => {
  // Initialize Lucide Icons
  lucide.createIcons();

  // OS Detection & Download Button Configuration
  const primaryDownloadBtn = document.getElementById("primary-download-btn");
  const primaryDownloadSublabel = document.getElementById("primary-download-sublabel");
  const primaryChecksum = document.getElementById("primary-checksum");
  const copyChecksumBtn = document.getElementById("copy-checksum-btn");

  const platforms = {
    mac: {
      label: "Download for macOS (Apple Silicon)",
      sublabel: "Apple Silicon DMG • v0.1.0",
      checksum: "eaf487e25d5f5c0e56e0637a6c457abd7ac0a40c94b12e256424443e658e067b",
      url: "https://github.com/AIArchitectsLabs/tessera/releases/download/app-v0.1.0/Tessera_0.1.0_aarch64.dmg",
      cardId: "dl-mac",
    },
    windows: {
      label: "Download for Windows (MSI)",
      sublabel: "x64 Setup • v0.1.0",
      checksum: "1d4179a3407e35cfd2dec724061f329cfaf112693b4b19e62922ab0825ab93b3",
      url: "https://github.com/AIArchitectsLabs/tessera/releases/download/app-v0.1.0/Tessera_0.1.0_x64_en-US.msi",
      cardId: "dl-win",
    },
    linux: {
      label: "Download for Linux (DEB)",
      sublabel: "Debian/Ubuntu x64 • v0.1.0",
      checksum: "241144ecc69e543e27b3bc2f7473755bb28a6c3453e485c719bcbde31b3b638d",
      url: "https://github.com/AIArchitectsLabs/tessera/releases/download/app-v0.1.0/Tessera_0.1.0_amd64.deb",
      cardId: "dl-linux",
    },
  };

  function detectOS() {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.indexOf("mac") !== -1) {
      return "mac";
    }
    if (userAgent.indexOf("win") !== -1) {
      return "windows";
    }
    if (userAgent.indexOf("linux") !== -1) {
      return "linux";
    }
    return "windows"; // Default fallback
  }

  const detectedOS = detectOS();
  const config = platforms[detectedOS];

  if (primaryDownloadBtn && config) {
    primaryDownloadBtn.href = config.url;
    primaryDownloadBtn.querySelector(".btn-label").textContent = config.label;
    primaryDownloadSublabel.textContent = config.sublabel;
    if (primaryChecksum) {
      primaryChecksum.textContent = `${config.checksum.substring(0, 16)}...`;
      primaryChecksum.dataset.fullChecksum = config.checksum;
    }

    // Highlight the card matching the detected OS
    const recommendedCard = document.getElementById(config.cardId);
    if (recommendedCard) {
      recommendedCard.classList.add("highlight");
    }
  }

  // Copy to Clipboard Utility
  const notification = document.getElementById("clipboard-notification");
  function showNotification(message) {
    if (!notification) return;
    notification.querySelector(".notification-message").textContent = message;
    notification.classList.add("show");
    setTimeout(() => {
      notification.classList.remove("show");
    }, 2500);
  }

  if (copyChecksumBtn) {
    copyChecksumBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const checksumVal = primaryChecksum.dataset.fullChecksum || config.checksum;
      navigator.clipboard.writeText(checksumVal).then(() => {
        showNotification("Checksum copied to clipboard!");
      });
    });
  }

  for (const btn of document.querySelectorAll(".copy-code-btn")) {
    btn.addEventListener("click", (e) => {
      const textToCopy = btn.getAttribute("data-clipboard");
      if (textToCopy) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          showNotification("Command copied!");
        });
      }
    });
  }

  // Interactive Live Mockup Controller
  const mockupContent = document.getElementById("mockup-content-pane");
  const tabButtons = document.querySelectorAll(".tab-btn");
  const sidebarItems = document.querySelectorAll(".sidebar-item");

  const tabContents = {
    inbox: {
      title: "Task Approvals",
      subtitle: "review and approve updates",
      sidebarId: "mockup-nav-inbox",
      html: `
        <div class="inbox-item urgent">
          <div class="item-meta">
            <span class="item-tag tag-red">Disruption Alert</span>
            <span class="item-time">Just now</span>
          </div>
          <h3 class="item-title">Review Supply Chain Disruption Report</h3>
          <p class="item-summary">
            Playbook <code>Supply Chain Risk Monitor</code> detected Port delays at Long Beach. The agent has compiled affected shipments and recommended alternative routing.
          </p>
          <div class="payload-box">
            <table class="mockup-table">
              <thead>
                <tr>
                  <th>Supplier</th>
                  <th>Affected Items</th>
                  <th>Alternative Port</th>
                  <th>Risk Level</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Apex Parts</td>
                  <td>2 shipments (SKU-992)</td>
                  <td>Port of Oakland</td>
                  <td><span class="badge-table badge-table-red">High</span></td>
                </tr>
                <tr>
                  <td>Global Logistics</td>
                  <td>1 shipment (SKU-441)</td>
                  <td>Port of Seattle</td>
                  <td><span class="badge-table badge-table-amber">Medium</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="item-actions">
            <button class="btn-mock btn-mock-danger">Reject Advice</button>
            <button class="btn-mock btn-mock-success">Approve Reroute</button>
          </div>
        </div>
      `,
    },
    playbooks: {
      title: "Automation Templates",
      subtitle: "Choose templates and configure guidelines",
      sidebarId: "mockup-nav-playbooks",
      html: `
        <div class="inbox-item">
          <div class="item-meta">
            <span class="item-tag tag-emerald">Playbook Active</span>
            <span class="item-time">Active</span>
          </div>
          <h3 class="item-title">Supply Chain Risk Monitor</h3>
          <p class="item-summary">
            Monitors global logistics lanes, checks supplier statuses, and flags potential delays.
          </p>
          <div class="payload-box">
            <pre><code>[✓] Step 1: Scan Port Statuses (Read API)
[✓] Step 2: Extract Delay Alerts (AI Signal Parsing)
[✓] Step 3: Map SKU Impact (Database cross-reference)
[⏸] Step 4: Await Manager Approval (Action Inbox Gate)
[ ] Step 5: Email Logistics Team (Notification)</code></pre>
          </div>
          <div class="item-actions">
            <button class="btn-mock btn-mock-secondary">Pause Run</button>
            <button class="btn-mock btn-mock-success" style="opacity: 0.6; cursor: not-allowed;" disabled>Running...</button>
          </div>
        </div>
      `,
    },
    ledger: {
      title: "History Log",
      subtitle: "Inspect changes side-by-side",
      sidebarId: "mockup-nav-history",
      html: `
        <div class="inbox-item">
          <div class="item-meta">
            <span class="item-tag tag-blue">History Commit</span>
            <span class="item-time">10m ago</span>
          </div>
          <h3 class="item-title">Supplier Contact Details Updated</h3>
          <p class="item-summary">
            Tessera Git Service recorded a file change by agent <code>SupplierSyncAgent</code>.
          </p>
          <div class="payload-box">
            <pre><code>Supplier: Apex Parts
- Regional Hub: Port of Seattle
+ Regional Hub: Port of Tacoma (Updated for backup lane)</code></pre>
          </div>
          <div class="item-actions">
            <button class="btn-mock btn-mock-danger">Rollback Changes</button>
            <button class="btn-mock btn-mock-success">Keep Changes</button>
          </div>
        </div>
      `,
    },
    memory: {
      title: "Instructions & Rules",
      subtitle: "Manage guidelines governing the automation",
      sidebarId: "mockup-nav-memory",
      html: `
        <div class="inbox-item">
          <div class="item-meta">
            <span class="item-tag tag-emerald">Active Rules</span>
            <span class="item-time">Synced</span>
          </div>
          <h3 class="item-title">Governing Principles for Agents</h3>
          <p class="item-summary">
            GBrain compiled facts and preferences to secure agent execution.
          </p>
          <div class="payload-box" style="padding: 0.6rem 0.8rem;">
            <ul style="list-style-type: disc; padding-left: 1rem; font-size: 0.65rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: 0.35rem; text-align: left;">
              <li>Only recommend alternative routes with under 15% estimated cost delta.</li>
              <li>Always require explicit manager approval for orders over $5,000.</li>
              <li>Apex Parts is the preferred supplier for North American lane disruptions.</li>
            </ul>
          </div>
          <div class="item-actions">
            <button class="btn-mock btn-mock-secondary">Add Custom Rule</button>
          </div>
        </div>
      `,
    },
  };

  function switchTab(tabId) {
    const data = tabContents[tabId];
    if (!data) return;

    // Update showcase buttons
    for (const btn of tabButtons) {
      if (btn.getAttribute("data-target") === tabId) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    }

    // Update mockup sidebar elements
    for (const item of sidebarItems) {
      if (item.id === data.sidebarId) {
        item.classList.add("active");
      } else {
        item.classList.remove("active");
      }
    }

    // Update sidebar section label dynamically to match Tessera
    const sidebarLabel = document.getElementById("mockup-sidebar-section-label");
    if (sidebarLabel) {
      if (tabId === "playbooks") {
        sidebarLabel.textContent = "PLAYBOOKS";
      } else if (tabId === "inbox") {
        sidebarLabel.textContent = "TASKS";
      } else if (tabId === "ledger") {
        sidebarLabel.textContent = "HISTORY";
      } else {
        sidebarLabel.textContent = "WORKSPACE";
      }
    }

    // Update content pane
    if (mockupContent) {
      mockupContent.innerHTML = `
        <div class="pane-header">
          <h2 class="pane-title">${data.title}</h2>
          <p class="pane-subtitle">${data.subtitle}</p>
        </div>
        <div class="pane-content">
          ${data.html}
        </div>
      `;
    }
  }

  // Wire up tabs events
  for (const btn of tabButtons) {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-target");
      switchTab(target);
    });
  }

  // Wire up mockup sidebar items to act like tabs too
  for (const item of sidebarItems) {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      if (item.id === "mockup-nav-inbox") switchTab("inbox");
      if (item.id === "mockup-nav-playbooks") switchTab("playbooks");
      if (item.id === "mockup-nav-history") switchTab("ledger");
      if (item.id === "mockup-nav-memory") switchTab("memory");
    });
  }

  // App Tour / Screenshots gallery tab switcher
  const tourTabBtns = document.querySelectorAll(".tour-tab-btn");
  const tourMainImage = document.getElementById("tour-main-image");
  const tourCaptionText = document.getElementById("tour-caption-text");

  for (const btn of tourTabBtns) {
    btn.addEventListener("click", () => {
      // Remove active class from all buttons
      for (const b of tourTabBtns) {
        b.classList.remove("active");
      }
      // Add active to current button
      btn.classList.add("active");

      // Update image and caption
      const imageSrc = btn.getAttribute("data-image");
      const captionText = btn.getAttribute("data-caption");

      if (tourMainImage && imageSrc) {
        tourMainImage.src = imageSrc;
      }
      if (tourCaptionText && captionText) {
        tourCaptionText.textContent = captionText;
      }
    });
  }
});
