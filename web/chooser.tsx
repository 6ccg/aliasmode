import { createRoot } from "react-dom/client";
import { BrowserChooserView } from "./browser-chooser.tsx";
import { I18nProvider } from "./i18n.tsx";

createRoot(document.getElementById("chooser-root")!).render(
  <I18nProvider><BrowserChooserView /></I18nProvider>,
);
