export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Warn = "warn",
  Error = "error",
}

export class Logger {
  readonly level: LogLevel;

  constructor(level: LogLevel) {
    this.level = level;
  }

  log(level: LogLevel, ...message: unknown[]) {
    const formattedMessages = message.map((msg) => {
      const isStringOrNumber =
        typeof msg === "string" || typeof msg === "number";

      return isStringOrNumber ? msg : JSON.stringify(msg, null, 2);
    });
    const output = `${
      new Date().toISOString().replace("T", " ").split(".")[0]
    } - ${level} - ${formattedMessages.join(" ")}`;

    switch (level) {
      case LogLevel.Debug:
        console.debug(output);
        return;
      case LogLevel.Info:
        console.info(output);
        return;
      case LogLevel.Warn:
        console.warn(output);
        return;
      case LogLevel.Error:
        console.error(output);
        return;
    }
  }

  debug(...msg: unknown[]) {
    this.log(LogLevel.Debug, ...msg);
  }

  info(...msg: unknown[]) {
    if (
      this.level === LogLevel.Info ||
      this.level === LogLevel.Warn ||
      this.level === LogLevel.Error
    ) {
      this.log(LogLevel.Info, ...msg);
    }
  }

  warn(...msg: unknown[]) {
    if (this.level === LogLevel.Warn || this.level === LogLevel.Error) {
      this.log(LogLevel.Warn, ...msg);
    }
  }

  error(...msg: unknown[]) {
    if (this.level === LogLevel.Error) {
      this.log(LogLevel.Error, ...msg);
    }
  }
}
