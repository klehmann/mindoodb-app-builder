import { config } from "@vue/test-utils";

import { i18n, setUiLanguage } from "./index";

// English, so component assertions read as the strings a reviewer sees in en.json
// rather than depending on the machine's own language.
setUiLanguage("en");
config.global.plugins.push(i18n);
