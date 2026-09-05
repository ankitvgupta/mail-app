/** Share a derived value across subscribers without retaining old inboxes. */
export function memoizeLast<Args extends unknown[], Result>(compute: (...args: Args) => Result) {
  let cached: { args: Args; result: Result } | undefined;
  return (...args: Args): Result => {
    const previous = cached;
    if (previous && args.every((arg, index) => Object.is(arg, previous.args[index]))) {
      return previous.result;
    }
    const result = compute(...args);
    cached = { args, result };
    return result;
  };
}
