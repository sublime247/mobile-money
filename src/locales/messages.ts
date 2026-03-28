/**
 * Localized error messages for multi-language API error responses.
 * 
 * Provides human-readable error messages in multiple languages (en, fr, es, pt).
 * Each error code maps to translated messages enabling users to see errors
 * in their preferred language based on Accept-Language header.
 * 
 * **Supported Languages:**
 * - `en`: English
 * - `fr`: French
 * - `es`: Spanish
 * - `pt`: Portuguese
 * 
 * **Usage:**
 * ```typescript
 * import { getLocalizedMessage } from './locales/messages';
 * import { ERROR_CODES } from './constants/errorCodes';
 * 
 * // Get message in user's language
 * const message = getLocalizedMessage(ERROR_CODES.INVALID_INPUT, 'fr');
 * // Returns: "Entrée invalide fournie"
 * 
 * // Falls back to English for unsupported languages
 * const fallback = getLocalizedMessage(ERROR_CODES.INVALID_INPUT, 'de');
 * // Returns: "Invalid input provided"
 * ```
 * 
 * @see getLocalizedMessage - For retrieving messages by code and language
 */

type Locale = "en" | "fr" | "es" | "pt";

export interface LocaleMessages {
  [key: string]: string;
}

/**
 * Error messages organized by language and error code.
 * 
 * Structure: messages[language][errorCode] = "Human-readable message"
 * 
 * All error codes must have messages in all supported languages
 * for consistent localization support.
 */
export const messages: Record<Locale, LocaleMessages> = {
  en: {
    // Validation errors
    INVALID_INPUT: "Invalid input provided",
    MISSING_FIELD: "Required field is missing",
    INVALID_PHONE_FORMAT: "Phone number format is invalid",
    INVALID_AMOUNT: "Amount must be a positive number",

    // Authentication errors
    UNAUTHORIZED: "Unauthorized access",
    INVALID_CREDENTIALS: "Invalid credentials provided",
    TOKEN_EXPIRED: "Authentication token has expired",
    INVALID_TOKEN: "Invalid authentication token",

    // Authorization errors
    FORBIDDEN: "Access forbidden",
    INSUFFICIENT_PERMISSIONS: "Insufficient permissions for this action",

    // Resource errors
    NOT_FOUND: "Resource not found",
    RESOURCE_NOT_FOUND: "The requested resource could not be found",
    TRANSACTION_NOT_FOUND: "Transaction not found",

    // Conflict errors
    CONFLICT: "Request conflicts with existing state",
    DUPLICATE_REQUEST: "Duplicate request detected",
    TRANSACTION_EXISTS: "Transaction already exists",

    // Business logic errors
    LIMIT_EXCEEDED: "Daily transaction limit exceeded",
    INSUFFICIENT_BALANCE: "Insufficient balance for this transaction",
    TRANSACTION_FAILED: "Transaction processing failed",
    PROVIDER_ERROR: "Mobile money provider error",
    RATE_LIMIT: "Too many requests. Please try again later",

    // Server errors
    INTERNAL_ERROR: "Internal server error",
    SERVICE_UNAVAILABLE: "Service temporarily unavailable",
    DATABASE_ERROR: "Database operation failed",
  },

  fr: {
    // Validation errors
    INVALID_INPUT: "Entrée invalide fournie",
    MISSING_FIELD: "Le champ requis est manquant",
    INVALID_PHONE_FORMAT: "Le format du numéro de téléphone est invalide",
    INVALID_AMOUNT: "Le montant doit être un nombre positif",

    // Authentication errors
    UNAUTHORIZED: "Accès non autorisé",
    INVALID_CREDENTIALS: "Identifiants invalides fournis",
    TOKEN_EXPIRED: "Le jeton d'authentification a expiré",
    INVALID_TOKEN: "Jeton d'authentification invalide",

    // Authorization errors
    FORBIDDEN: "Accès interdit",
    INSUFFICIENT_PERMISSIONS: "Permissions insuffisantes pour cette action",

    // Resource errors
    NOT_FOUND: "Ressource non trouvée",
    RESOURCE_NOT_FOUND: "La ressource demandée est introuvable",
    TRANSACTION_NOT_FOUND: "Transaction non trouvée",

    // Conflict errors
    CONFLICT: "La demande entre en conflit avec l'état existant",
    DUPLICATE_REQUEST: "Demande en double détectée",
    TRANSACTION_EXISTS: "La transaction existe déjà",

    // Business logic errors
    LIMIT_EXCEEDED: "Limite de transactions quotidiennes dépassée",
    INSUFFICIENT_BALANCE: "Solde insuffisant pour cette transaction",
    TRANSACTION_FAILED: "L'échec du traitement de la transaction",
    PROVIDER_ERROR: "Erreur du fournisseur de monnaie mobile",
    RATE_LIMIT: "Trop de demandes. Veuillez réessayer plus tard",

    // Server errors
    INTERNAL_ERROR: "Erreur interne du serveur",
    SERVICE_UNAVAILABLE: "Le service est temporairement indisponible",
    DATABASE_ERROR: "L'opération de base de données a échoué",
  },

  es: {
    // Validation errors
    INVALID_INPUT: "Entrada inválida proporcionada",
    MISSING_FIELD: "Falta el campo requerido",
    INVALID_PHONE_FORMAT: "El formato del número de teléfono es inválido",
    INVALID_AMOUNT: "La cantidad debe ser un número positivo",

    // Authentication errors
    UNAUTHORIZED: "Acceso no autorizado",
    INVALID_CREDENTIALS: "Credenciales inválidas proporcionadas",
    TOKEN_EXPIRED: "El token de autenticación ha expirado",
    INVALID_TOKEN: "Token de autenticación inválido",

    // Authorization errors
    FORBIDDEN: "Acceso prohibido",
    INSUFFICIENT_PERMISSIONS: "Permisos insuficientes para esta acción",

    // Resource errors
    NOT_FOUND: "Recurso no encontrado",
    RESOURCE_NOT_FOUND: "No se pudo encontrar el recurso solicitado",
    TRANSACTION_NOT_FOUND: "Transacción no encontrada",

    // Conflict errors
    CONFLICT: "La solicitud entra en conflicto con el estado existente",
    DUPLICATE_REQUEST: "Solicitud duplicada detectada",
    TRANSACTION_EXISTS: "La transacción ya existe",

    // Business logic errors
    LIMIT_EXCEEDED: "Límite de transacciones diarias excedido",
    INSUFFICIENT_BALANCE: "Saldo insuficiente para esta transacción",
    TRANSACTION_FAILED: "Fallo en el procesamiento de la transacción",
    PROVIDER_ERROR: "Error del proveedor de dinero móvil",
    RATE_LIMIT: "Demasiadas solicitudes. Por favor, inténtelo más tarde",

    // Server errors
    INTERNAL_ERROR: "Error interno del servidor",
    SERVICE_UNAVAILABLE: "El servicio no está disponible temporalmente",
    DATABASE_ERROR: "La operación de base de datos falló",
  },

  pt: {
    // Validation errors
    INVALID_INPUT: "Entrada inválida fornecida",
    MISSING_FIELD: "O campo obrigatório está faltando",
    INVALID_PHONE_FORMAT: "O formato do número de telefone é inválido",
    INVALID_AMOUNT: "O valor deve ser um número positivo",

    // Authentication errors
    UNAUTHORIZED: "Acesso não autorizado",
    INVALID_CREDENTIALS: "Credenciais inválidas fornecidas",
    TOKEN_EXPIRED: "Token de autenticação expirado",
    INVALID_TOKEN: "Token de autenticação inválido",

    // Authorization errors
    FORBIDDEN: "Acesso proibido",
    INSUFFICIENT_PERMISSIONS: "Permissões insuficientes para esta ação",

    // Resource errors
    NOT_FOUND: "Recurso não encontrado",
    RESOURCE_NOT_FOUND: "O recurso solicitado não foi encontrado",
    TRANSACTION_NOT_FOUND: "Transação não encontrada",

    // Conflict errors
    CONFLICT: "A solicitação entra em conflito com o estado existente",
    DUPLICATE_REQUEST: "Solicitação duplicada detectada",
    TRANSACTION_EXISTS: "A transação já existe",

    // Business logic errors
    LIMIT_EXCEEDED: "Limite de transações diárias excedido",
    INSUFFICIENT_BALANCE: "Saldo insuficiente para esta transação",
    TRANSACTION_FAILED: "Falha no processamento da transação",
    PROVIDER_ERROR: "Erro do provedor de dinheiro móvel",
    RATE_LIMIT: "Muitas solicitações. Tente novamente mais tarde",

    // Server errors
    INTERNAL_ERROR: "Erro interno do servidor",
    SERVICE_UNAVAILABLE: "O serviço está temporariamente indisponível",
    DATABASE_ERROR: "Falha na operação do banco de dados",
  },
};

/**
 * Retrieves a localized error message for a given error code and language.
 * 
 * Falls back to English message if the requested language is not supported
 * or if the error code is not found in the language's message map.
 * 
 * **Fallback Behavior:**
 * 1. First tries to get message for requested language
 * 2. If not found in language, tries English
 * 3. If not found in English, returns default message
 * 
 * @param {string} code - Error code to look up (e.g., INVALID_INPUT)
 * @param {Locale} [locale="en"] - Locale/language code (en, fr, es, pt)
 * @returns {string} Localized error message (guaranteed to return a string)
 * 
 * @example
 * // Get French message
 * getLocalizedMessage(ERROR_CODES.INVALID_INPUT, 'fr');
 * // Returns: "Entrée invalide fournie"
 * 
 * // Fallback to English for unsupported language
 * getLocalizedMessage(ERROR_CODES.INVALID_INPUT, 'de');
 * // Returns: "Invalid input provided"
 * 
 * // Default if code not found
 * getLocalizedMessage('UNKNOWN_CODE');
 * // Returns: "An error occurred"
 */
export const getLocalizedMessage = (
  code: string,
  locale: Locale = "en",
): string => {
  const localeMessages = messages[locale] || messages.en;
  return localeMessages[code] || messages.en[code] || "An error occurred";
};