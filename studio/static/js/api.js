// Thin REST client for the studio backend.

async function request(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.detail) msg = typeof data.detail === "string" ? data.detail : data.detail.map(d => d.msg).join("; ");
    } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("application/json") ? res.json() : res;
}

export const api = {
  get: url => request("GET", url),
  post: (url, body) => request("POST", url, body ?? {}),
  put: (url, body) => request("PUT", url, body),
  patch: (url, body) => request("PATCH", url, body),
  del: url => request("DELETE", url),

  status: () => request("GET", "/api/status"),
  project: pid => request("GET", `/api/projects/${pid}`),
  projects: () => request("GET", "/api/projects"),
  voices: () => request("GET", "/api/voices"),
  outputs: () => request("GET", "/api/outputs"),

  async peaks(pid) {
    const res = await fetch(`/api/projects/${pid}/peaks`);
    if (!res.ok) throw new Error("Waveform not ready");
    return new Uint8Array(await res.arrayBuffer());
  },

  // Upload with progress (fetch has no upload progress events).
  upload(url, form, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data?.detail || `${xhr.status} ${xhr.statusText}`));
      };
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(form);
    });
  },
};

// Poll a job until it finishes; resolves with the job, rejects on error.
export async function waitJob(job, onUpdate) {
  let delay = 300;
  for (;;) {
    const j = await api.get(`/api/jobs/${job.id}`);
    onUpdate?.(j);
    if (j.status === "done") return j;
    if (j.status === "error") throw new Error(j.error || "Job failed");
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(1000, delay * 1.3);
  }
}
