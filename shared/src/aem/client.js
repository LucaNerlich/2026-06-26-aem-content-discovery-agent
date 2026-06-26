import { ofetch, FetchError } from "ofetch";

export class AemAuthError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AemAuthError";
    this.cause = cause;
  }
}

export class AemNotFoundError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AemNotFoundError";
    this.cause = cause;
  }
}

export class AemConflictError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AemConflictError";
    this.cause = cause;
  }
}

export class AemUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AemUnavailableError";
    this.cause = cause;
  }
}

export class AemRequestError extends Error {
  constructor(message, status, cause) {
    super(message);
    this.name = "AemRequestError";
    this.status = status;
    this.cause = cause;
  }
}

function basicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function normalizeError(error, { method, path }) {
  if (error instanceof FetchError) {
    const status = error.status ?? error.statusCode;
    const detail = `${method} ${path} → ${status ?? "network error"}`;
    if (status === 401 || status === 403) {
      return new AemAuthError(`AEM authentication failed (${detail})`, error);
    }
    if (status === 404) {
      return new AemNotFoundError(`AEM resource not found (${detail})`, error);
    }
    if (status === 409) {
      return new AemConflictError(`AEM resource conflict (${detail})`, error);
    }
    if (status === undefined) {
      return new AemUnavailableError(`AEM unreachable (${detail})`, error);
    }
    return new AemRequestError(`AEM request failed (${detail})`, status, error);
  }
  return new AemUnavailableError(`AEM request error (${method} ${path}): ${error.message}`, error);
}

export function createAemClient({
  baseUrl = "http://localhost:4502",
  username = "admin",
  password = "admin",
  timeoutMs = 15000,
  fetch: customFetch,
} = {}) {
  const $fetch = ofetch.create(
    {
      baseURL: baseUrl,
      timeout: timeoutMs,
      headers: {
        Authorization: basicAuthHeader(username, password),
      },
    },
    customFetch ? { fetch: customFetch } : {},
  );

  async function request(method, path, options = {}) {
    try {
      return await $fetch(path, { method, ...options });
    } catch (error) {
      throw normalizeError(error, { method, path });
    }
  }

  return {
    baseUrl,
    get: (path, options) => request("GET", path, options),
    post: (path, body, options = {}) =>
      request("POST", path, {
        ...options,
        body,
      }),
    put: (path, body, options = {}) =>
      request("PUT", path, {
        ...options,
        body,
      }),
    delete: (path, options) => request("DELETE", path, options),
    postForm: (path, formBody, options = {}) =>
      request("POST", path, {
        ...options,
        body: formBody,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...(options.headers ?? {}),
        },
      }),
  };
}
