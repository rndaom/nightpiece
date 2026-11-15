/**
 * A group of radios is one stop for the Tab key, and the arrow keys move within it. The chosen
 * one is the stop (`tabIndex`), and the arrows choose as they move, as radios do.
 */
export function stop(on: boolean): 0 | -1 {
  return on ? 0 : -1;
}

/** The key handler for the group's own element: `ids` in order, the one now chosen, and what choosing does. */
export function arrows<T>(ids: readonly T[], current: T, choose: (id: T) => void) {
  return (e: KeyboardEvent) => {
    const at = ids.indexOf(current);
    let to = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = (at + 1) % ids.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = (at - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = ids.length - 1;
    if (to < 0) return;
    // The page's own keys (the arrows step through the game) are not for a control that is being used.
    e.preventDefault();
    e.stopPropagation();
    choose(ids[to]!);
    (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };
}
