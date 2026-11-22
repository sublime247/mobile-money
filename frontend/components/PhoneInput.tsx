import React, { useState, useEffect, useMemo, ChangeEvent } from "react";

export type SupportedCountryCode = "CM" | "SN" | "CI" | "NG" | "KE" | "GH";

export interface CountryInfo {
  code: SupportedCountryCode;
  name: string;
  dialCode: string;
  flag: string;
  nationalNumberLength: number | number[]; // Expected national digits without dial code
  format: (nationalDigits: string) => string;
}

export interface CarrierInfo {
  id: string;
  name: string;
  displayName: string;
  badgeColor: string;
  textColor: string;
  logoText: string;
}

export interface PhoneValidationResult {
  isValid: boolean;
  isPrefixValid: boolean;
  isLengthValid: boolean;
  formattedNumber: string;
  e164Number: string;
  country: CountryInfo | null;
  carrier: CarrierInfo | null;
  errorMessage?: string;
}

export interface PhoneInputProps {
  value?: string;
  defaultValue?: string;
  defaultCountry?: SupportedCountryCode;
  onChange?: (result: PhoneValidationResult) => void;
  disabled?: boolean;
  required?: boolean;
  label?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  id?: string;
  name?: string;
}

export const COUNTRIES: Record<SupportedCountryCode, CountryInfo> = {
  CM: {
    code: "CM",
    name: "Cameroon",
    dialCode: "+237",
    flag: "🇨🇲",
    nationalNumberLength: 9,
    format: (digits: string) => {
      // Format: 6XX XX XX XX or 2XX XX XX XX
      const parts: string[] = [];
      if (digits.length > 0) parts.push(digits.substring(0, 3));
      if (digits.length > 3) parts.push(digits.substring(3, 5));
      if (digits.length > 5) parts.push(digits.substring(5, 7));
      if (digits.length > 7) parts.push(digits.substring(7, 9));
      return parts.join(" ");
    },
  },
  SN: {
    code: "SN",
    name: "Senegal",
    dialCode: "+221",
    flag: "🇸🇳",
    nationalNumberLength: 9,
    format: (digits: string) => {
      // Format: 7X XXX XX XX
      const parts: string[] = [];
      if (digits.length > 0) parts.push(digits.substring(0, 2));
      if (digits.length > 2) parts.push(digits.substring(2, 5));
      if (digits.length > 5) parts.push(digits.substring(5, 7));
      if (digits.length > 7) parts.push(digits.substring(7, 9));
      return parts.join(" ");
    },
  },
  CI: {
    code: "CI",
    name: "Ivory Coast",
    dialCode: "+225",
    flag: "🇨🇮",
    nationalNumberLength: 10, // 10-digit format standard in Côte d'Ivoire
    format: (digits: string) => {
      // Format: 0X XX XX XX XX
      const parts: string[] = [];
      if (digits.length > 0) parts.push(digits.substring(0, 2));
      if (digits.length > 2) parts.push(digits.substring(2, 4));
      if (digits.length > 4) parts.push(digits.substring(4, 6));
      if (digits.length > 6) parts.push(digits.substring(6, 8));
      if (digits.length > 8) parts.push(digits.substring(8, 10));
      return parts.join(" ");
    },
  },
  NG: {
    code: "NG",
    name: "Nigeria",
    dialCode: "+234",
    flag: "🇳🇬",
    nationalNumberLength: 10, // National format without leading 0
    format: (digits: string) => {
      // Format: 803 123 4567
      const parts: string[] = [];
      if (digits.length > 0) parts.push(digits.substring(0, 3));
      if (digits.length > 3) parts.push(digits.substring(3, 6));
      if (digits.length > 6) parts.push(digits.substring(6, 10));
      return parts.join(" ");
    },
  },
  KE: {
    code: "KE",
    name: "Kenya",
    dialCode: "+254",
    flag: "🇰🇪",
    nationalNumberLength: 9, // without leading 0 (e.g. 712345678)
    format: (digits: string) => {
      // Format: 712 345 678
      const parts: string[] = [];
      if (digits.length > 0) parts.push(digits.substring(0, 3));
      if (digits.length > 3) parts.push(digits.substring(3, 6));
      if (digits.length > 6) parts.push(digits.substring(6, 9));
      return parts.join(" ");
    },
  },
  GH: {
    code: "GH",
    name: "Ghana",
    dialCode: "+233",
    flag: "🇬🇭",
    nationalNumberLength: 9, // without leading 0 (e.g. 241234567)
    format: (digits: string) => {
      // Format: 24 123 4567
      const parts: string[] = [];
      if (digits.length > 0) parts.push(digits.substring(0, 2));
      if (digits.length > 2) parts.push(digits.substring(2, 5));
      if (digits.length > 5) parts.push(digits.substring(5, 9));
      return parts.join(" ");
    },
  },
};

export const CARRIER_DEFINITIONS: Record<string, CarrierInfo> = {
  mtn: {
    id: "mtn",
    name: "MTN MoMo",
    displayName: "MTN MoMo",
    badgeColor: "#FFCC00",
    textColor: "#000000",
    logoText: "MTN",
  },
  orange: {
    id: "orange",
    name: "Orange Money",
    displayName: "Orange Money",
    badgeColor: "#FF7900",
    textColor: "#FFFFFF",
    logoText: "Orange",
  },
  mpesa: {
    id: "mpesa",
    name: "M-Pesa",
    displayName: "M-Pesa",
    badgeColor: "#00A859",
    textColor: "#FFFFFF",
    logoText: "M-Pesa",
  },
  airtel: {
    id: "airtel",
    name: "Airtel Money",
    displayName: "Airtel Money",
    badgeColor: "#E40000",
    textColor: "#FFFFFF",
    logoText: "Airtel",
  },
  nexttel: {
    id: "nexttel",
    name: "Nexttel",
    displayName: "Nexttel",
    badgeColor: "#0072CE",
    textColor: "#FFFFFF",
    logoText: "Nexttel",
  },
  camtel: {
    id: "camtel",
    name: "Camtel Blue",
    displayName: "Camtel",
    badgeColor: "#0055A5",
    textColor: "#FFFFFF",
    logoText: "Camtel",
  },
  free: {
    id: "free",
    name: "Free Money",
    displayName: "Free Money",
    badgeColor: "#C8102E",
    textColor: "#FFFFFF",
    logoText: "Free",
  },
  expresso: {
    id: "expresso",
    name: "Expresso",
    displayName: "Expresso",
    badgeColor: "#4B286D",
    textColor: "#FFFFFF",
    logoText: "Expresso",
  },
  moov: {
    id: "moov",
    name: "Moov Money",
    displayName: "Moov Money",
    badgeColor: "#0033A0",
    textColor: "#FFFFFF",
    logoText: "Moov",
  },
  glo: {
    id: "glo",
    name: "Glo",
    displayName: "Glo",
    badgeColor: "#2D8C3C",
    textColor: "#FFFFFF",
    logoText: "Glo",
  },
  ninemobile: {
    id: "9mobile",
    name: "9mobile",
    displayName: "9mobile",
    badgeColor: "#006847",
    textColor: "#FFFFFF",
    logoText: "9mobile",
  },
  telecel: {
    id: "telecel",
    name: "Telecel / Vodafone Cash",
    displayName: "Telecel",
    badgeColor: "#E60000",
    textColor: "#FFFFFF",
    logoText: "Telecel",
  },
  airteltigo: {
    id: "airteltigo",
    name: "AirtelTigo Money",
    displayName: "AirtelTigo",
    badgeColor: "#1A5276",
    textColor: "#FFFFFF",
    logoText: "AirtelTigo",
  },
  telkom: {
    id: "telkom",
    name: "Telkom T-Kash",
    displayName: "T-Kash",
    badgeColor: "#0099DA",
    textColor: "#FFFFFF",
    logoText: "Telkom",
  },
};

/**
 * Prefix lookup maps by country code
 */
export const CARRIER_PREFIX_MAP: Record<SupportedCountryCode, Array<{ prefix: string; carrier: string }>> = {
  CM: [
    // MTN Cameroon: 67, 68, 650-654
    { prefix: "67", carrier: "mtn" },
    { prefix: "68", carrier: "mtn" },
    { prefix: "650", carrier: "mtn" },
    { prefix: "651", carrier: "mtn" },
    { prefix: "652", carrier: "mtn" },
    { prefix: "653", carrier: "mtn" },
    { prefix: "654", carrier: "mtn" },
    // Orange Cameroon: 69, 655-659
    { prefix: "69", carrier: "orange" },
    { prefix: "655", carrier: "orange" },
    { prefix: "656", carrier: "orange" },
    { prefix: "657", carrier: "orange" },
    { prefix: "658", carrier: "orange" },
    { prefix: "659", carrier: "orange" },
    // Nexttel: 66
    { prefix: "66", carrier: "nexttel" },
    // Camtel: 62, 242, 243
    { prefix: "62", carrier: "camtel" },
    { prefix: "242", carrier: "camtel" },
    { prefix: "243", carrier: "camtel" },
  ],
  SN: [
    // Orange Senegal: 77, 78
    { prefix: "77", carrier: "orange" },
    { prefix: "78", carrier: "orange" },
    // Free Senegal: 76
    { prefix: "76", carrier: "free" },
    // Expresso: 70
    { prefix: "70", carrier: "expresso" },
    // Promobile: 75
    { prefix: "75", carrier: "free" },
  ],
  CI: [
    // Orange CI: 07 (or 7)
    { prefix: "07", carrier: "orange" },
    { prefix: "7", carrier: "orange" },
    // MTN CI: 05 (or 5)
    { prefix: "05", carrier: "mtn" },
    { prefix: "5", carrier: "mtn" },
    // Moov CI: 01 (or 1)
    { prefix: "01", carrier: "moov" },
    { prefix: "1", carrier: "moov" },
  ],
  NG: [
    // MTN Nigeria
    { prefix: "803", carrier: "mtn" },
    { prefix: "806", carrier: "mtn" },
    { prefix: "813", carrier: "mtn" },
    { prefix: "816", carrier: "mtn" },
    { prefix: "810", carrier: "mtn" },
    { prefix: "814", carrier: "mtn" },
    { prefix: "903", carrier: "mtn" },
    { prefix: "906", carrier: "mtn" },
    { prefix: "703", carrier: "mtn" },
    { prefix: "706", carrier: "mtn" },
    { prefix: "704", carrier: "mtn" },
    { prefix: "707", carrier: "mtn" },
    { prefix: "7025", carrier: "mtn" },
    { prefix: "7026", carrier: "mtn" },
    // Airtel Nigeria
    { prefix: "802", carrier: "airtel" },
    { prefix: "808", carrier: "airtel" },
    { prefix: "812", carrier: "airtel" },
    { prefix: "701", carrier: "airtel" },
    { prefix: "708", carrier: "airtel" },
    { prefix: "902", carrier: "airtel" },
    { prefix: "901", carrier: "airtel" },
    { prefix: "907", carrier: "airtel" },
    { prefix: "912", carrier: "airtel" },
    // Glo Nigeria
    { prefix: "805", carrier: "glo" },
    { prefix: "807", carrier: "glo" },
    { prefix: "815", carrier: "glo" },
    { prefix: "811", carrier: "glo" },
    { prefix: "705", carrier: "glo" },
    { prefix: "905", carrier: "glo" },
    { prefix: "915", carrier: "glo" },
    // 9mobile Nigeria
    { prefix: "809", carrier: "ninemobile" },
    { prefix: "817", carrier: "ninemobile" },
    { prefix: "818", carrier: "ninemobile" },
    { prefix: "909", carrier: "ninemobile" },
    { prefix: "908", carrier: "ninemobile" },
  ],
  KE: [
    // Safaricom M-Pesa
    { prefix: "70", carrier: "mpesa" },
    { prefix: "71", carrier: "mpesa" },
    { prefix: "72", carrier: "mpesa" },
    { prefix: "740", carrier: "mpesa" },
    { prefix: "741", carrier: "mpesa" },
    { prefix: "742", carrier: "mpesa" },
    { prefix: "743", carrier: "mpesa" },
    { prefix: "745", carrier: "mpesa" },
    { prefix: "746", carrier: "mpesa" },
    { prefix: "747", carrier: "mpesa" },
    { prefix: "748", carrier: "mpesa" },
    { prefix: "757", carrier: "mpesa" },
    { prefix: "758", carrier: "mpesa" },
    { prefix: "759", carrier: "mpesa" },
    { prefix: "768", carrier: "mpesa" },
    { prefix: "769", carrier: "mpesa" },
    { prefix: "79", carrier: "mpesa" },
    { prefix: "110", carrier: "mpesa" },
    { prefix: "111", carrier: "mpesa" },
    { prefix: "112", carrier: "mpesa" },
    { prefix: "113", carrier: "mpesa" },
    { prefix: "114", carrier: "mpesa" },
    { prefix: "115", carrier: "mpesa" },
    // Airtel Kenya
    { prefix: "73", carrier: "airtel" },
    { prefix: "750", carrier: "airtel" },
    { prefix: "751", carrier: "airtel" },
    { prefix: "752", carrier: "airtel" },
    { prefix: "753", carrier: "airtel" },
    { prefix: "754", carrier: "airtel" },
    { prefix: "755", carrier: "airtel" },
    { prefix: "756", carrier: "airtel" },
    { prefix: "78", carrier: "airtel" },
    { prefix: "100", carrier: "airtel" },
    { prefix: "101", carrier: "airtel" },
    { prefix: "102", carrier: "airtel" },
    // Telkom Kenya (T-Kash)
    { prefix: "77", carrier: "telkom" },
  ],
  GH: [
    // MTN Ghana
    { prefix: "24", carrier: "mtn" },
    { prefix: "54", carrier: "mtn" },
    { prefix: "55", carrier: "mtn" },
    { prefix: "59", carrier: "mtn" },
    { prefix: "25", carrier: "mtn" },
    // Telecel / Vodafone Ghana
    { prefix: "20", carrier: "telecel" },
    { prefix: "50", carrier: "telecel" },
    // AirtelTigo Ghana
    { prefix: "27", carrier: "airteltigo" },
    { prefix: "57", carrier: "airteltigo" },
    { prefix: "26", carrier: "airteltigo" },
    { prefix: "56", carrier: "airteltigo" },
  ],
};

/**
 * Detect country from dialed string or dial prefix
 */
export function detectCountry(input: string): CountryInfo | null {
  const clean = input.trim().replace(/[^\d+]/g, "");
  for (const country of Object.values(COUNTRIES)) {
    if (clean.startsWith(country.dialCode) || clean.startsWith(country.dialCode.replace("+", ""))) {
      return country;
    }
  }
  return null;
}

/**
 * Detect carrier based on national digits and country
 */
export function detectCarrier(countryCode: SupportedCountryCode, nationalDigits: string): CarrierInfo | null {
  const prefixes = CARRIER_PREFIX_MAP[countryCode];
  if (!prefixes) return null;

  // Sort prefixes by descending length so longest matching prefix wins
  const sorted = [...prefixes].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const item of sorted) {
    if (nationalDigits.startsWith(item.prefix)) {
      const carrier = CARRIER_DEFINITIONS[item.carrier];
      if (carrier) return carrier;
    }
  }

  return null;
}

/**
 * Validates and parses phone input
 */
export function validatePhoneNumber(
  input: string,
  selectedCountry?: CountryInfo | null,
): PhoneValidationResult {
  const raw = input.trim();
  if (!raw) {
    return {
      isValid: false,
      isPrefixValid: true,
      isLengthValid: true,
      formattedNumber: "",
      e164Number: "",
      country: selectedCountry || null,
      carrier: null,
    };
  }

  let country = selectedCountry;
  let digits = raw.replace(/\D/g, "");

  // Auto-detect country if input starts with +
  if (raw.startsWith("+")) {
    const detected = detectCountry(raw);
    if (detected) {
      country = detected;
      const dialDigits = detected.dialCode.replace("+", "");
      if (digits.startsWith(dialDigits)) {
        digits = digits.slice(dialDigits.length);
      }
    }
  }

  if (!country) {
    return {
      isValid: false,
      isPrefixValid: false,
      isLengthValid: false,
      formattedNumber: raw,
      e164Number: raw.startsWith("+") ? raw : `+${digits}`,
      country: null,
      carrier: null,
      errorMessage: "Unknown country calling code",
    };
  }

  // Remove leading 0 if user enters domestic format like 0803... or 07... (except in CI where 10 digits start with 0)
  let nationalDigits = digits;
  if (country.code !== "CI" && nationalDigits.startsWith("0")) {
    nationalDigits = nationalDigits.slice(1);
  }

  const carrier = detectCarrier(country.code, nationalDigits);
  const expectedLengths = Array.isArray(country.nationalNumberLength)
    ? country.nationalNumberLength
    : [country.nationalNumberLength];

  const isPrefixValid = nationalDigits.length === 0 || carrier !== null;
  const isLengthValid = expectedLengths.includes(nationalDigits.length);
  const isTooLong = nationalDigits.length > Math.max(...expectedLengths);
  const isTooShort = nationalDigits.length < Math.min(...expectedLengths);

  let errorMessage: string | undefined;
  if (nationalDigits.length > 0 && !carrier) {
    errorMessage = `Invalid carrier prefix for ${country.name}`;
  } else if (nationalDigits.length > 0 && isTooLong) {
    errorMessage = `Phone number is too long for ${country.name} (expected ${expectedLengths.join(" or ")} digits)`;
  } else if (nationalDigits.length > 0 && isTooShort && !isLengthValid) {
    errorMessage = `Phone number is incomplete (expected ${expectedLengths.join(" or ")} digits)`;
  }

  const isValid = isPrefixValid && isLengthValid && carrier !== null;
  const formattedNational = country.format(nationalDigits);
  const formattedNumber = `${country.dialCode} ${formattedNational}`.trim();
  const e164Number = `${country.dialCode}${nationalDigits}`;

  return {
    isValid,
    isPrefixValid,
    isLengthValid,
    formattedNumber,
    e164Number,
    country,
    carrier,
    errorMessage: isValid ? undefined : errorMessage,
  };
}

/**
 * Phone Number Input component with auto-flag and carrier detection
 */
export const PhoneInput: React.FC<PhoneInputProps> = ({
  value,
  defaultValue = "",
  defaultCountry = "CM",
  onChange,
  disabled = false,
  required = false,
  label = "Phone Number",
  placeholder,
  className = "",
  inputClassName = "",
  id = "phone-input",
  name = "phoneNumber",
}) => {
  const [selectedCountryCode, setSelectedCountryCode] = useState<SupportedCountryCode>(defaultCountry);
  const [inputValue, setInputValue] = useState<string>(value ?? defaultValue);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const selectedCountry = COUNTRIES[selectedCountryCode];

  const validation = useMemo(() => {
    return validatePhoneNumber(inputValue, selectedCountry);
  }, [inputValue, selectedCountry]);

  useEffect(() => {
    if (value !== undefined) {
      setInputValue(value);
      const detected = detectCountry(value);
      if (detected) {
        setSelectedCountryCode(detected.code);
      }
    }
  }, [value]);

  useEffect(() => {
    onChange?.(validation);
  }, [validation, onChange]);

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val.startsWith("+")) {
      const detected = detectCountry(val);
      if (detected && detected.code !== selectedCountryCode) {
        setSelectedCountryCode(detected.code);
      }
    }
    setInputValue(val);
  };

  const handleCountrySelect = (countryCode: SupportedCountryCode) => {
    setSelectedCountryCode(countryCode);
    setIsDropdownOpen(false);
  };

  const hasError = inputValue.trim().length > 0 && (!validation.isValid || !validation.isPrefixValid);

  return (
    <div className={`phone-input-container w-full font-sans ${className}`} data-testid="phone-input-container">
      {label && (
        <label htmlFor={id} className="block text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
      )}

      <div className="relative flex items-center">
        {/* Country Selector Button */}
        <div className="relative">
          <button
            type="button"
            data-testid="country-select-button"
            disabled={disabled}
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="flex items-center space-x-1.5 px-3 py-2.5 bg-gray-50 dark:bg-gray-800 border border-r-0 border-gray-300 dark:border-gray-600 rounded-l-lg hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
            aria-haspopup="listbox"
            aria-expanded={isDropdownOpen}
          >
            <span className="text-xl" role="img" aria-label={selectedCountry.name}>
              {selectedCountry.flag}
            </span>
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {selectedCountry.dialCode}
            </span>
            <svg
              className={`w-3.5 h-3.5 text-gray-500 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {/* Country Dropdown */}
          {isDropdownOpen && (
            <ul
              role="listbox"
              data-testid="country-dropdown-list"
              className="absolute z-50 left-0 mt-1 w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl max-h-60 overflow-y-auto py-1"
            >
              {Object.values(COUNTRIES).map((c) => (
                <li
                  key={c.code}
                  role="option"
                  aria-selected={c.code === selectedCountryCode}
                  data-testid={`country-option-${c.code}`}
                  onClick={() => handleCountrySelect(c.code)}
                  className={`flex items-center justify-between px-3 py-2 text-sm cursor-pointer hover:bg-blue-50 dark:hover:bg-gray-700 ${
                    c.code === selectedCountryCode ? "bg-blue-50 dark:bg-gray-700 font-semibold text-blue-600 dark:text-blue-400" : "text-gray-700 dark:text-gray-200"
                  }`}
                >
                  <span className="flex items-center space-x-2">
                    <span className="text-lg">{c.flag}</span>
                    <span>{c.name}</span>
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 font-mono">{c.dialCode}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Input Field */}
        <input
          type="tel"
          id={id}
          name={name}
          data-testid="phone-number-input"
          value={inputValue}
          onChange={handleInputChange}
          disabled={disabled}
          required={required}
          placeholder={placeholder || selectedCountry.format("671234567")}
          className={`flex-1 w-full px-3.5 py-2.5 bg-white dark:bg-gray-900 border rounded-r-lg text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 transition-colors ${
            hasError
              ? "border-red-500 focus:border-red-500 focus:ring-red-200 dark:focus:ring-red-900"
              : validation.isValid
              ? "border-green-500 focus:border-green-500 focus:ring-green-200 dark:focus:ring-green-900"
              : "border-gray-300 dark:border-gray-600 focus:border-blue-500 focus:ring-blue-200 dark:focus:ring-blue-900"
          } ${inputClassName}`}
        />

        {/* Dynamic Carrier Badge */}
        {validation.carrier && (
          <div
            data-testid="carrier-badge"
            style={{
              backgroundColor: validation.carrier.badgeColor,
              color: validation.carrier.textColor,
            }}
            className="absolute right-3 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold shadow-sm transition-all animate-fadeIn"
          >
            {validation.carrier.displayName}
          </div>
        )}
      </div>

      {/* Real-time Validation Error / Status Feedback */}
      {hasError && validation.errorMessage && (
        <p data-testid="phone-error-message" className="mt-1.5 text-xs text-red-600 dark:text-red-400 flex items-center">
          <svg className="w-3.5 h-3.5 mr-1 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
          {validation.errorMessage}
        </p>
      )}

      {validation.isValid && validation.formattedNumber && (
        <p data-testid="phone-valid-feedback" className="mt-1.5 text-xs text-green-600 dark:text-green-400 flex items-center">
          <svg className="w-3.5 h-3.5 mr-1 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
          Valid number ({validation.formattedNumber})
        </p>
      )}
    </div>
  );
};

export default PhoneInput;
