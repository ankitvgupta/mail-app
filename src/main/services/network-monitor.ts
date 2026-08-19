import { EventEmitter } from "events";
import { createRequire } from "module";
import type * as Electron from "electron";
import { createLogger } from "./logger";

const log = createLogger("network");
const requireFromHere = createRequire(import.meta.url);

function getElectron(): typeof Electron {
  return requireFromHere("electron") as typeof Electron;
}

type NetworkEvent = "online" | "offline";

class NetworkMonitor extends EventEmitter {
  private _isOnline: boolean = true;
  private initialized: boolean = false;

  /**
   * Initialize the network monitor.
   * Should be called after app.whenReady()
   */
  init(): void {
    if (this.initialized) return;
    const { net, powerMonitor } = getElectron();

    // Get initial state from Electron's net module
    this._isOnline = net.isOnline();
    log.info(`[NetworkMonitor] Initial state: ${this._isOnline ? "online" : "offline"}`);

    // Listen for system wake from sleep - check connectivity
    powerMonitor.on("resume", () => {
      // Small delay to let network reconnect after wake
      setTimeout(() => {
        const wasOnline = this._isOnline;
        this._isOnline = net.isOnline();
        log.info(
          `[NetworkMonitor] Wake from sleep, network: ${this._isOnline ? "online" : "offline"}`,
        );

        if (!wasOnline && this._isOnline) {
          this.emit("online");
        } else if (wasOnline && !this._isOnline) {
          this.emit("offline");
        }
      }, 1000);
    });

    this.initialized = true;
  }

  /**
   * Get current online status
   */
  get isOnline(): boolean {
    return this._isOnline;
  }

  /**
   * Update network status from renderer process (navigator.onLine)
   * The renderer can detect network changes more reliably in some cases
   */
  updateFromRenderer(online: boolean): void {
    if (this._isOnline !== online) {
      const wasOnline = this._isOnline;
      this._isOnline = online;
      log.info(`[NetworkMonitor] Status changed from renderer: ${online ? "online" : "offline"}`);

      if (!wasOnline && online) {
        this.emit("online");
      } else if (wasOnline && !online) {
        this.emit("offline");
      }
    }
  }

  /**
   * Force set offline (called when we detect a network error during send)
   */
  setOffline(): void {
    if (this._isOnline) {
      this._isOnline = false;
      log.info("[NetworkMonitor] Forced offline due to network error");
      this.emit("offline");
    }
  }

  /**
   * Check and update online status (can be called to verify state)
   */
  checkStatus(): boolean {
    const { net } = getElectron();
    const current = net.isOnline();
    if (current !== this._isOnline) {
      const wasOnline = this._isOnline;
      this._isOnline = current;
      log.info(`[NetworkMonitor] Status check: ${current ? "online" : "offline"}`);

      if (!wasOnline && current) {
        this.emit("online");
      } else if (wasOnline && !current) {
        this.emit("offline");
      }
    }
    return this._isOnline;
  }

  // Type-safe event methods
  on(event: NetworkEvent, listener: () => void): this {
    return super.on(event, listener);
  }

  off(event: NetworkEvent, listener: () => void): this {
    return super.off(event, listener);
  }

  emit(event: NetworkEvent): boolean {
    return super.emit(event);
  }
}

// Export singleton instance
export const networkMonitor = new NetworkMonitor();
