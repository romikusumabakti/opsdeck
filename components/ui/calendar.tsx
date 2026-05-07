"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";
import { DayPicker, getDefaultClassNames } from "react-day-picker";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  const defaults = getDefaultClassNames();
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("bg-background p-3", className)}
      classNames={{
        ...defaults,
        months: cn("flex flex-col sm:flex-row gap-4", defaults.months),
        month: cn("flex flex-col w-full gap-4", defaults.month),
        month_caption: cn(
          "flex items-center justify-center h-7 w-full px-8 relative",
          defaults.month_caption
        ),
        caption_label: cn("text-sm font-medium", defaults.caption_label),
        nav: cn(
          "absolute inset-x-0 top-0 flex justify-between items-center",
          defaults.nav
        ),
        button_previous: cn(
          buttonVariants({ variant: "outline" }),
          "size-7 p-0 select-none aria-disabled:opacity-50",
          defaults.button_previous
        ),
        button_next: cn(
          buttonVariants({ variant: "outline" }),
          "size-7 p-0 select-none aria-disabled:opacity-50",
          defaults.button_next
        ),
        weekdays: cn("flex", defaults.weekdays),
        weekday: cn(
          "text-muted-foreground rounded-md flex-1 font-normal text-[0.8rem]",
          defaults.weekday
        ),
        week: cn("flex w-full mt-2", defaults.week),
        day: cn(
          "relative flex-1 aspect-square text-center text-sm select-none",
          defaults.day
        ),
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "size-9 p-0 font-normal aria-selected:opacity-100",
          defaults.day_button
        ),
        selected: cn(
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground rounded-md",
          defaults.selected
        ),
        today: cn("bg-accent text-accent-foreground rounded-md", defaults.today),
        outside: cn("text-muted-foreground opacity-50", defaults.outside),
        disabled: cn("text-muted-foreground opacity-50", defaults.disabled),
        hidden: cn("invisible", defaults.hidden),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: chevronClass, ...rest }) => {
          const Icon = orientation === "left" ? ChevronLeftIcon : ChevronRightIcon;
          return <Icon className={cn("size-4", chevronClass)} {...rest} />;
        },
      }}
      {...props}
    />
  );
}

export { Calendar };
