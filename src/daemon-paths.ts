import * as path from "path";

export const SOCKET_PATH = path.join(
  process.env.TMPDIR ?? "/tmp",
  "amaran-light.sock"
);

export const PID_PATH = path.join(
  process.env.TMPDIR ?? "/tmp",
  "amaran-light.pid"
);
