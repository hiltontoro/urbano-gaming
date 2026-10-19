import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Test harness: the SHIPPED /competitions-admin.html and /competitions.html, parsed and run whole in jsdom, with only the auth bridge
 * and the network supplied by the test. It exists so a test can say, for a given caller, exactly which actionable controls a page shows.
 */

const ADMIN_HTML = readFileSync(path.join(process.cwd(), "public/competitions-admin.html"), "utf8");
const MEMBER_HTML = readFileSync(path.join(process.cwd(), "public/competitions.html"), "utf8");
const LIFECYCLE_SOURCE = readFileSync(path.join(process.cwd(), "public/competitionsLifecycle.js"), "utf8");
const INTENT_SOURCE = readFileSync(path.join(process.cwd(), "public/competitionsIntent.js"), "utf8");

export interface PageRequest { url: string; method: string; headers: Record<string, string>; body?: string }
export interface PageResponse { status: number; json?: unknown }
export type PageTransport = (request: PageRequest) => PageResponse | Promise<PageResponse>;

export interface AdminPage {
  win: Window & Record<string, any>;
  doc: Document;
  requests: PageRequest[];
  settle(predicate: () => boolean, label?: string): Promise<void>;
  /** Every actionable control the caller can currently see, in document order, excluding the shared header chrome. */
  controls(): string[];
  /** The page's own words, as text. */
  text(): string;
  /** Fires the page's registered auth-state callback, as a Supabase session refresh does. */
  fireAuthChange(): Promise<void>;
  close(): void;
}

interface OpenOptions {
  auth: unknown;
  accessToken?: string;
  transport: PageTransport;
  /** The query string the page is opened with, e.g. "?c=abc". */
  search?: string;
}

function open(html: string, pathname: string, opts: OpenOptions, extraScripts: string[]): AdminPage {
  const requests: PageRequest[] = [];
  const authCallbacks: Array<() => unknown> = [];
  const dom = new JSDOM(html, {
    url: `http://localhost${pathname}${opts.search ?? ""}`,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(window) {
      const w = window as unknown as Record<string, any>;
      w.UrbanoAuth = {
        attachSignInButton: () => {},
        getState: async () => opts.auth,
        getAccessToken: async () => opts.accessToken ?? "stub-token",
        onAuthStateChange: async (callback: () => unknown) => { authCallbacks.push(callback); return () => {}; },
      };
      w.fetch = async (url: string, init: any = {}) => {
        const request: PageRequest = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
        requests.push(request);
        const out = await opts.transport(request);
        return { status: out.status, json: async () => { if (out.json === undefined) throw new Error("no body"); return out.json; } };
      };
      for (const source of extraScripts) window.eval(source);
    },
  });
  const win = dom.window as unknown as Window & Record<string, any>;
  const doc = win.document;

  const isVisible = (el: Element): boolean => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const e = node as HTMLElement;
      if (e.hidden) return false;
      if (e.style && (e.style.display === "none" || e.style.visibility === "hidden")) return false;
    }
    return true;
  };
  const describe = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const label = (el.textContent ?? "").trim().replace(/\s+/g, " ") || el.getAttribute("placeholder") || el.getAttribute("class") || "";
    return `${tag}[${label}]`;
  };

  return {
    win, doc, requests,
    async settle(predicate, label = "condition") {
      for (let i = 0; i < 600; i++) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    },
    controls() {
      const found = Array.from(doc.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary"));
      return found
        .filter((el) => !el.closest(".back-link") && el.id !== "btn-signin" && isVisible(el))
        .map(describe);
    },
    text: () => doc.body.textContent ?? "",
    async fireAuthChange() { for (const callback of authCallbacks) await callback(); },
    close: () => win.close(),
  };
}

/** The organizer page, /competitions-admin.html. */
export async function openAdminPage(opts: OpenOptions): Promise<AdminPage> {
  return open(ADMIN_HTML, "/competitions-admin.html", opts, [LIFECYCLE_SOURCE]);
}

/** The member competition page, /competitions.html (the addressed-competition surface). */
export async function openMemberPage(opts: OpenOptions): Promise<AdminPage> {
  return open(MEMBER_HTML, "/competitions.html", opts, [INTENT_SOURCE]);
}
