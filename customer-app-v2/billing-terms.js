// Package rules follows the customer's language choice (#360); the page is
// served in English.
import { getPreferredLanguage } from "/shared/i18n.js";
import { localize, setDocumentLanguage } from "/shared/ui/dom.js";

localize(document, setDocumentLanguage(getPreferredLanguage()));
