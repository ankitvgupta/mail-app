import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";

// Root command wrapper
const Command = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive
    ref={ref}
    className={`flex h-full w-full flex-col overflow-hidden bg-white dark:bg-gray-800 ${className ?? ""}`}
    {...props}
  />
));
Command.displayName = "Command";

// Search input
const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Input
    ref={ref}
    className={`flex-1 h-10 bg-transparent text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 outline-none disabled:opacity-50 ${className ?? ""}`}
    {...props}
  />
));
CommandInput.displayName = "CommandInput";

// Scrollable results list
const CommandList = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.List
    ref={ref}
    className={`max-h-80 overflow-y-auto overflow-x-hidden py-1 ${className ?? ""}`}
    {...props}
  />
));
CommandList.displayName = "CommandList";

// Empty state
const CommandEmpty = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Empty>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>
>((props, ref) => (
  <CommandPrimitive.Empty
    ref={ref}
    className="py-8 text-center text-sm text-gray-500 dark:text-gray-400"
    {...props}
  />
));
CommandEmpty.displayName = "CommandEmpty";

// Group with heading
const CommandGroup = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Group>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group
    ref={ref}
    className={`overflow-hidden [&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-gray-400 [&_[cmdk-group-heading]]:dark:text-gray-500 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider ${className ?? ""}`}
    {...props}
  />
));
CommandGroup.displayName = "CommandGroup";

// Separator between groups
const CommandSeparator = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator
    ref={ref}
    className={`h-px bg-gray-200 dark:bg-gray-700 ${className ?? ""}`}
    {...props}
  />
));
CommandSeparator.displayName = "CommandSeparator";

// Selectable item
const CommandItem = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>
>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item
    ref={ref}
    className={`relative flex items-center gap-3 px-4 py-2 text-sm cursor-pointer select-none text-gray-700 dark:text-gray-300 data-[selected=true]:bg-blue-50 data-[selected=true]:dark:bg-blue-900/30 data-[selected=true]:text-blue-700 data-[selected=true]:dark:text-blue-300 ${className ?? ""}`}
    {...props}
  />
));
CommandItem.displayName = "CommandItem";

// Keyboard shortcut badge (right-aligned in an item)
function CommandShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`ml-auto px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded font-mono text-gray-500 dark:text-gray-400 ${className ?? ""}`}
      {...props}
    />
  );
}

export {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandSeparator,
  CommandItem,
  CommandShortcut,
};
