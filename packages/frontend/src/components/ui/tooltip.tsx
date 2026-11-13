import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

/** Shares the open delay, so moving between icons shows the next tip at once. */
function TooltipProvider({ delay = 300, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  align = "center",
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "side" | "sideOffset" | "align">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "max-w-64 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md origin-(--transform-origin) duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="data-[side=bottom]:top-[-4px] data-[side=top]:bottom-[-4px] data-[side=left]:right-[-4px] data-[side=right]:left-[-4px]">
            <span className="block size-2 rotate-45 rounded-[1px] bg-foreground" />
          </TooltipPrimitive.Arrow>
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/**
 * A small tip shown on hover or keyboard focus. Pass the control as the only
 * child. A disabled control gets no pointer events, so `disabled` wraps it in
 * a focusable span to still explain why it's off.
 */
function Hint({
  label,
  side,
  disabled = false,
  children,
}: {
  label: React.ReactNode
  side?: "top" | "bottom" | "left" | "right"
  disabled?: boolean
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          disabled ? <span tabIndex={0} className="inline-flex cursor-not-allowed" /> : children
        }
      >
        {disabled ? children : undefined}
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}

export { Hint, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
