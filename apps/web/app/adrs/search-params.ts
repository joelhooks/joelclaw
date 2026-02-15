import {
  createLoader,
  parseAsArrayOf,
  parseAsString,
} from "nuqs/server";

export const adrSearchParams = {
  status: parseAsArrayOf(parseAsString, ","),
};

export const loadAdrSearchParams = createLoader(adrSearchParams);
