"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type SpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult:
    ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror:
    ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
} & EventTarget;

type SpeechRecognitionEvent = {
  results: SpeechRecognitionResultList;
  resultIndex: number;
} & Event;

type SpeechRecognitionResultList = {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
};

type SpeechRecognitionResult = {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
};

type SpeechRecognitionAlternative = {
  transcript: string;
  confidence: number;
};

type SpeechRecognitionErrorEvent = {
  error: string;
} & Event;

export type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognition;
  webkitSpeechRecognition?: new () => SpeechRecognition;
};

export type SpeechToTextFaultCode =
  | "unsupported"
  | "insecure-context"
  | "not-allowed"
  | "service-not-allowed"
  | "network"
  | "audio-capture"
  | "language-not-supported"
  | "bad-grammar"
  | "unknown";

export type SpeechToTextFault = { code: SpeechToTextFaultCode };

const QUIET_ERRORS = new Set(["no-speech", "aborted"]);

const RECOGNITION_FAULT_CODES = new Set<string>([
  "not-allowed",
  "service-not-allowed",
  "network",
  "audio-capture",
  "language-not-supported",
  "bad-grammar",
]);

// why: engines differ on a leading space, so glue to exactly one gap
function joinSpoken(left: string, right: string) {
  if (!left || !right) {
    return left + right;
  }
  return /\s$/.test(left) || /^\s/.test(right)
    ? left + right
    : `${left} ${right}`;
}

function readTranscript(results: SpeechRecognitionResultList) {
  const finals: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result?.isFinal) {
      break;
    }
    finals.push(result[0]?.transcript ?? "");
  }

  return finals
    .filter((transcript, index) => {
      const next = finals[index + 1];
      return next === undefined || !next.startsWith(transcript);
    })
    .reduce(joinSpoken, "");
}

export type UseSpeechToTextOptions = {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onTranscriptionChange?: (text: string) => void;
};

export function useSpeechToText({
  textareaRef,
  onTranscriptionChange,
}: UseSpeechToTextOptions = {}) {
  const [isListening, setIsListening] = useState(false);
  const [availability, setAvailability] = useState<
    "unknown" | "ready" | "unsupported" | "insecure-context"
  >("unknown");
  const [fault, setFault] = useState<SpeechToTextFault | null>(null);
  const [transcript, setTranscript] = useState("");
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const writtenRef = useRef("");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const speechWindow = window as SpeechRecognitionWindow;
    const SpeechRecognitionCtor =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAvailability("unsupported");
      return;
    }

    if (window.isSecureContext === false) {
      setAvailability("insecure-context");
      return;
    }

    const recognition = new SpeechRecognitionCtor();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      writtenRef.current = "";
      setIsListening(true);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.onresult = (event) => {
      const textarea = textareaRef?.current;
      if (!textarea) {
        return;
      }

      const spoken = readTranscript(event.results);
      const written = writtenRef.current;
      const continues = written !== "" && spoken.startsWith(written);
      const addition = continues ? spoken.slice(written.length) : spoken;

      if (!addition) {
        return;
      }
      writtenRef.current = spoken;

      const currentValue = textarea.value;
      const newValue = continues
        ? currentValue + addition
        : joinSpoken(currentValue, addition);

      textarea.value = newValue;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      setTranscript(newValue);
      onTranscriptionChange?.(newValue);
    };

    recognition.onerror = (event) => {
      setIsListening(false);
      if (QUIET_ERRORS.has(event.error)) {
        return;
      }
      setFault({
        code: RECOGNITION_FAULT_CODES.has(event.error)
          ? (event.error as SpeechToTextFaultCode)
          : "unknown",
      });
    };

    recognitionRef.current = recognition;
    setAvailability("ready");

    return () => {
      recognition.stop();
    };
  }, [textareaRef, onTranscriptionChange]);

  const toggleListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (availability !== "ready" || !recognition) {
      setFault({
        code:
          availability === "insecure-context" ? availability : "unsupported",
      });
      return;
    }

    setFault(null);

    if (isListening) {
      recognition.stop();
    } else {
      recognition.start();
    }
  }, [availability, isListening]);

  return {
    isListening,
    isSupported: availability === "ready",
    fault,
    toggleListening,
    transcript,
  };
}
