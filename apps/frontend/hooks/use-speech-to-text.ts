"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface SpeechRecognition extends EventTarget {
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
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

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

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

declare global {
  interface Window {
    SpeechRecognition: {
      new (): SpeechRecognition;
    };
    webkitSpeechRecognition: {
      new (): SpeechRecognition;
    };
  }
}

/**
 * Why dictation is not working, as a code the caller turns into words
 * (issue #768). `unsupported` and `insecure-context` are standing conditions
 * of the page; the rest are the `error` values `SpeechRecognitionErrorEvent`
 * defines for an attempt that failed.
 */
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

/**
 * A failure worth telling the user about. A fresh object each time, so a
 * caller watching it sees a second identical failure as a second event rather
 * than as no change.
 */
export type SpeechToTextFault = { code: SpeechToTextFaultCode };

/**
 * Failures the user caused or already knows about: silence, and stopping
 * dictation yourself. Ending quietly is the honest response to both.
 */
const QUIET_ERRORS = new Set(["no-speech", "aborted"]);

const RECOGNITION_FAULT_CODES = new Set<string>([
  "not-allowed",
  "service-not-allowed",
  "network",
  "audio-capture",
  "language-not-supported",
  "bad-grammar",
]);

/**
 * Runs two pieces of speech together with exactly one gap between them.
 * Engines differ on whether a result carries its own leading space, so both
 * gluing the words and doubling the space are possible without this.
 */
const joinSpoken = (left: string, right: string) => {
  if (!left || !right) {
    return left + right;
  }
  return /\s$/.test(left) || /^\s/.test(right)
    ? left + right
    : `${left} ${right}`;
};

/**
 * The transcript the result list describes, whichever way the engine chose to
 * fill it in.
 *
 * By the spec each result is its own segment of speech, so the session's
 * transcript is every final result run together. Chrome for Android instead
 * grows the list by one `isFinal` entry per partial update, and each entry
 * carries the whole utterance so far, so running them together repeats every
 * word once for each entry it appears in (issue #752).
 *
 * One rule covers both: an entry that the next one begins with was restated by
 * it and only the later one counts. Segments of genuinely different speech are
 * not prefixes of one another, so they all survive. Judging each entry against
 * its neighbour rather than the list as a whole keeps a coincidence — one
 * phrase that happens to open the next — down to that pair.
 */
const readTranscript = (results: SpeechRecognitionResultList) => {
  const finals: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    // Only the tail of the list can still be interim, so stop at the first one
    // and pick those indices up once they are final.
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
};

export type UseSpeechToTextOptions = {
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onTranscriptionChange?: (text: string) => void;
};

/**
 * Drives the browser's Web Speech API and appends finalized transcripts
 * onto the given textarea, dispatching a native "input" event so any
 * uncontrolled/controlled listeners on it stay in sync.
 */
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
  // The part of this session's transcript already written into the textarea.
  // Every result event carries the session's transcript from the top, so what
  // is new is whatever this does not already cover — which is what makes a
  // replayed or restated result a no-op instead of a repeat.
  const writtenRef = useRef("");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    if (!(
      "SpeechRecognition" in window || "webkitSpeechRecognition" in window
    )) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAvailability("unsupported");
      return;
    }

    // The constructor is on `window` on insecure origins too, so the API looks
    // available right up until `start()` fails with `not-allowed` — a browser
    // will not grant the microphone outside a secure context. Saying so up
    // front beats a mic button that claims to work and doesn't (issue #768).
    if (window.isSecureContext === false) {
      setAvailability("insecure-context");
      return;
    }

    const SpeechRecognitionCtor =
      window.SpeechRecognition || window.webkitSpeechRecognition;
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
      // A transcript that carries on the one already written extends it; one
      // that doesn't belongs to a result list the engine started afresh, and
      // is new speech in its own right.
      const continues = written !== "" && spoken.startsWith(written);
      const addition = continues ? spoken.slice(written.length) : spoken;

      if (!addition) {
        return;
      }
      writtenRef.current = spoken;

      const currentValue = textarea.value;
      // An extension is an exact continuation of what is in the box, down to
      // whether it starts mid-word, so it goes on verbatim. Anything else
      // begins a new run of speech and needs a gap from what is there.
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
    // Whether dictation can run here is only knowable after mount, and it is
    // what the mic button answers a press with; this setState is part of
    // initialising that external system.
    setAvailability("ready");

    return () => {
      recognition.stop();
    };
  }, [textareaRef, onTranscriptionChange]);

  const toggleListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (availability !== "ready" || !recognition) {
      // Nothing to toggle, so answer the tap with the reason instead of
      // leaving it looking like a missed press.
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
