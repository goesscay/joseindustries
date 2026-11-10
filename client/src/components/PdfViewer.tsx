import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Modal, Space, Spin, message } from "antd";
import { DownloadOutlined, ShareAltOutlined } from "@ant-design/icons";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

export interface PdfTarget {
  /** API path including the /api prefix, e.g. `/api/tax-invoices/12/pdf`. */
  url: string;
  /** File name offered on download / share (without extension). */
  filename: string;
  title: string;
}

function safeName(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
}

async function fetchPdf(url: string): Promise<Blob> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    let msg = "Failed to load PDF";
    try {
      msg = (await res.json()).message ?? msg;
    } catch {
      // not JSON - keep the generic message
    }
    throw new Error(msg);
  }
  return res.blob();
}

function saveBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = safeName(filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** Opens the phone/OS share sheet with the PDF attached. Where the browser
 * cannot share files (most desktop browsers) the PDF is downloaded instead, so
 * the button always does something useful. */
async function sharePdf(blob: Blob, filename: string, title: string) {
  const file = new File([blob], safeName(filename), { type: "application/pdf" });
  if (typeof navigator.share === "function" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
    } catch (err) {
      // Closing the share sheet is not an error.
      if (!(err instanceof DOMException && err.name === "AbortError")) throw err;
    }
    return;
  }
  saveBlob(blob, filename);
  message.info("Sharing isn't available on this browser - the PDF was downloaded instead.");
}

/** Buttons for a list row's Actions column: download and share without opening
 * the viewer first. */
export function usePdfActions() {
  const [viewing, setViewing] = useState<PdfTarget | null>(null);

  const download = useCallback(async (t: PdfTarget) => {
    try {
      saveBlob(await fetchPdf(t.url), t.filename);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to download PDF");
    }
  }, []);

  const share = useCallback(async (t: PdfTarget) => {
    try {
      await sharePdf(await fetchPdf(t.url), t.filename, t.title);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to share PDF");
    }
  }, []);

  const view = useCallback((t: PdfTarget) => setViewing(t), []);

  const viewer = <PdfViewerModal target={viewing} onClose={() => setViewing(null)} />;
  return { view, download, share, viewer };
}

function PdfViewerModal({ target, onClose }: { target: PdfTarget | null; onClose: () => void }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    let doc: pdfjs.PDFDocumentProxy | null = null;
    setBlob(null);
    setError(null);
    setLoading(true);

    (async () => {
      try {
        const data = await fetchPdf(target.url);
        if (cancelled) return;
        setBlob(data);
        doc = await pdfjs.getDocument({ data: await data.arrayBuffer() }).promise;
        // The modal body mounts just after open flips; give it a few frames.
        for (let i = 0; i < 20 && !pagesRef.current; i += 1) await new Promise((r) => requestAnimationFrame(r));
        const host = pagesRef.current;
        if (cancelled || !host) return;
        host.innerHTML = "";
        // Drawn onto canvases (not an <iframe>/<embed>) because Android Chrome
        // cannot display a PDF embedded in a page.
        const cssWidth = Math.max(host.clientWidth, 280);
        const ratio = Math.min(window.devicePixelRatio || 1, 3);
        for (let n = 1; n <= doc.numPages; n += 1) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (cssWidth / base.width) * ratio });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.cssText = `width:${cssWidth}px;height:${Math.floor(viewport.height / ratio)}px;display:block;margin:0 auto 12px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)`;
          host.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load PDF");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      void doc?.destroy();
    };
  }, [target]);

  async function handleShare() {
    if (!target || !blob) return;
    try {
      await sharePdf(blob, target.filename, target.title);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to share PDF");
    }
  }

  return (
    <Modal
      open={!!target}
      onCancel={onClose}
      title={target?.title}
      width={860}
      style={{ top: 12 }}
      destroyOnClose
      footer={
        <Space>
          <Button icon={<DownloadOutlined />} disabled={!blob} onClick={() => target && blob && saveBlob(blob, target.filename)}>
            Download
          </Button>
          <Button type="primary" icon={<ShareAltOutlined />} disabled={!blob} onClick={handleShare}>
            Share
          </Button>
        </Space>
      }
    >
      <div style={{ maxHeight: "72vh", overflowY: "scroll", overflowX: "hidden", background: "#f0f0f0", padding: 8, minHeight: 120 }}>
        {loading && (
          <div style={{ textAlign: "center", padding: 24 }}>
            <Spin />
          </div>
        )}
        {error && <div style={{ color: "#cf1322", padding: 16 }}>{error}</div>}
        <div ref={pagesRef} />
      </div>
    </Modal>
  );
}
