import { NotFoundScreen } from "@/components/not-found-screen";

/**
 * App Router's 404. Orbit had no not-found screen at all before this — an
 * unmatched URL fell through to Next's built-in page, which is unbranded
 * and, more importantly, unthemed. Spec: design/family/404.html.
 */
export default function NotFound() {
  return <NotFoundScreen />;
}
