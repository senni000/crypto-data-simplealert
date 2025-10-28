const WRAP_FLAG = Symbol.for('consoleTimestampWrapped');

// Avoid wrapping multiple times if module is imported more than once.
if (!(console as any)[WRAP_FLAG]) {
  const wrapMethod = (method: 'log' | 'info' | 'warn' | 'error' | 'debug') => {
    const original = console[method].bind(console);

    console[method] = (...args: unknown[]): void => {
      const timestamp = new Date().toISOString();

      if (args.length === 0) {
        original(`[${timestamp}]`);
        return;
      }

      const [first, ...rest] = args;

      if (typeof first === 'string') {
        original(`[${timestamp}] ${first}`, ...rest);
      } else {
        original(`[${timestamp}]`, first, ...rest);
      }
    };
  };

  wrapMethod('log');
  wrapMethod('info');
  wrapMethod('warn');
  wrapMethod('error');
  wrapMethod('debug');

  (console as any)[WRAP_FLAG] = true;
}
