import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useTranslation } from "@/i18n";

/** The Feedback entry in the sidebar's Admin section, styled like its links. */
export function FeedbackButton({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) {
      toast.error(t("feedback.too_short"));
      return;
    }
    setSubmitting(true);
    try {
      await api.submitFeedback({ message: trimmed, page_url: location.pathname });
      toast.success(t("feedback.success"));
      setMessage("");
      setOpen(false);
    } catch {
      toast.error(t("feedback.error"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("feedback.button")}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 rounded-md text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <MessageSquare className="h-4 w-4 shrink-0" />
        {!collapsed && <span>{t("feedback.button")}</span>}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("feedback.title")}</DialogTitle>
              <DialogDescription>{t("feedback.description")}</DialogDescription>
            </DialogHeader>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("feedback.placeholder")}
              rows={5}
              maxLength={5000}
              autoFocus
              required
            />
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={submitting || !message.trim()}>
                {submitting ? t("feedback.submitting") : t("feedback.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
