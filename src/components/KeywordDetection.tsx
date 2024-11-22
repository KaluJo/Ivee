import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button, Text, Alert, Stack, Group, Paper, useMantineTheme, Image, Code, Flex, Center } from '@mantine/core';
import { Mic, MicOff, AlertCircle } from 'lucide-react';
import Anthropic from '@anthropic-ai/sdk';

import { IoIosMic } from "react-icons/io";
import { CiMicrophoneOff, CiMicrophoneOn } from "react-icons/ci";
import { RiMicLine } from "react-icons/ri";

type EventType = 'wake' | 'yes' | 'no' | 'query' | 'analysis' | 'screenshot' | 'response';

const ANTHROPIC_API_KEY = process.env.REACT_APP_ANTHROPIC_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.REACT_APP_ELEVENLABS_API_KEY || '';
const VOICE_ID = process.env.REACT_APP_VOICE_ID || '';
const ACCESS_KEY = process.env.REACT_APP_ACCESS_KEY || '';

interface IConversationContext {
  lastScreenshot?: {
    image: string;
    ocrText: string;
    analysis: any;
  };
  messageHistory: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
  }>;
}

interface IEvent {
  timestamp: string;
  data: {
    speaker?: string;
    screenshot?: {
      image: string;
    };
    text?: string;
    context?: string;
  };
}

interface AudioPlayer {
  play(): Promise<void>;
}

const KeywordDetection = () => {
  const [isSpeechListening, setIsSpeechListening] = useState(false);

  const handleStartListening = async () => {
    try {
      await invoke('start_keyword_detection', { accessKey: ACCESS_KEY });
      setIsListening(true);
      setError(null);
    } catch (err) {
      console.error('Error starting keyword detection:', err);
      setError(err.toString());
    }
  };

  const handleStopListening = async () => {
    try {
      await invoke('stop_keyword_detection');
      setIsListening(false);
      setError(null);
    } catch (err) {
      console.error('Error stopping keyword detection:', err);
      setError(err.toString());
    }
  };

  const [greeted, setGreeted] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [events, setEvents] = useState<IEvent[]>([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const theme = useMantineTheme();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [waitingForConsent, setWaitingForConsent] = useState(false);
  const permissionAudio = useRef<AudioPlayer | null>(null);
  const readyAudio = useRef<AudioPlayer | null>(null);
  const captureAudio = useRef<AudioPlayer | null>(null);

  const anthropic = new Anthropic({
    apiKey: ANTHROPIC_API_KEY,
    dangerouslyAllowBrowser: true
  });

  useEffect(() => {
    permissionAudio.current = new Audio('/permission.mp3');
    readyAudio.current = new Audio('/ivee_gentle.mp3');
    captureAudio.current = new Audio('/ivee_capture.mp3');
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const eventDump = (events: IEvent[]): string => {
    return events
      .slice(0, 5)
      .filter(event => event.data.speaker && event.data.text)
      .map(event => {
        const contextInfo = event.data.context ? ` (Context: ${event.data.context})` : '';
        return `${event.data.speaker}: ${event.data.text}${contextInfo}`;
      })
      .join('\n');
  };

  const generateResponse = async (newEvent?: IEvent) => {
    try {
      let eventHistory = newEvent ? [newEvent, ...events] : events;
      eventHistory = eventHistory.splice(0, 3);
      const messages = [
        {
          role: "assistant" as const,
          content: "Hi, today I am your assistant named Ivee and you are Bhada. I can only say up to two sentences at a time. How can I help you?",
        },
        {
          role: "user" as const,
          content: `Awesome to hear that! Here is what we talked about, say the two sentences in response to all this: ${eventDump(eventHistory)}`
        }
      ];

      const response = await anthropic.messages.create({
        model: "claude-3-5-sonnet-latest",
        max_tokens: 150,
        messages: messages
      });

      let responseText = response?.content[0]?.text;

      if (responseText) {
        const responseEvent: IEvent = {
          timestamp: new Date().toISOString(),
          data: {
            speaker: 'Ivee',
            text: responseText
          }
        };
        setEvents(prev => [responseEvent, ...prev.slice(0, 5)]);

        console.log('Response:', responseText);

        await textToSpeech(responseText);
      };
    } catch (err) {
      console.error('Error generating response:', err);
      return "I apologize, but I encountered an issue processing that request.";
    }
  };

  const textToSpeech = async (text: string) => {
    console.log('Text to speech:', text);

    try {
      const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_turbo_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5
          }
        })
      });

      console.log('Response:', response);

      if (!response.ok) throw new Error('Failed to generate speech');

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      await audio.play();

      return audio;
    } catch (err) {
      console.error('Error in text-to-speech:', err);
      throw err;
    }
  };

  const handleConsentFlow = async () => {
    if (waitingForConsent) return;

    try {
      setWaitingForConsent(true);

      if (permissionAudio.current) {
        await permissionAudio.current.play();
        await new Promise(resolve => {
          (permissionAudio.current as unknown as HTMLAudioElement).onended = resolve;
        });
      }

      const consent = await invoke('listen_for_consent', {
        accessKey: ACCESS_KEY
      });

      const newEvent: IEvent = {
        timestamp: new Date().toISOString(),
        data: {
          text: consent === 'allowed' ? 'Bhada gave permission.' : 'Bhada did not give permission.'
        }
      };
      setEvents(prev => [newEvent, ...prev.slice(0, 5)]);

      if (consent === 'allowed') {
        if (captureAudio.current) {
          await captureAudio.current.play();
          await new Promise(resolve => {
            (captureAudio.current as unknown as HTMLAudioElement).onended = resolve;
          });
        }

        await handleScreenshotAnalysis();
      }
    } catch (err) {
      console.error('Error in consent flow:', err);
      setError(err.toString());
    } finally {
      setWaitingForConsent(false);
      handleStartListening();
    }
  };

  const listenForSpeech = async (): Promise<string> => {
    try {
      setIsSpeechListening(true);
      const transcription = await invoke('listen_for_speech', {
        accessKey: ACCESS_KEY
      });

      const cleanTranscription = String(transcription).trim();
      console.log('Speech recognized:', cleanTranscription);

      if (!cleanTranscription) {
        throw new Error('No speech detected');
      }

      return cleanTranscription;
    } catch (err) {
      console.error('Speech recognition error:', err);
      throw err;
    } finally {
      setIsSpeechListening(false);
    }
  };

  const handleScreenshotAnalysis = async () => {
    setLoading(true);
    try {
      const { text, image } = await invoke<{ text: string; image: string }>('take_screenshot_and_ocr');

      const screenshotEvent: IEvent = {
        timestamp: new Date().toISOString(),
        data: {
          screenshot: {
            image: `data:image/png;base64,${image}`,
          },
          context: text
        }
      };
      setEvents(prev => [screenshotEvent, ...prev.slice(0, 5)]);

      const textAnalysis = await analyzeText(text);

      const newEvent: IEvent = {
        timestamp: new Date().toISOString(),
        data: {
          speaker: 'Ivee',
          text: textAnalysis
        }
      };

      setEvents(prev => [newEvent, ...prev.slice(0, 5)]);

      await textToSpeech(textAnalysis);
    } catch (err) {
      setError(err.toString());
    } finally {
      setLoading(false);
    }
  };

  const analyzeText = async (text: string) => {
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const response = await anthropic.messages.create({
        model: "claude-3-sonnet-20240229",
        max_tokens: 2024,
        messages: [{
          role: "assistant",
          content: `${eventDump(events)}`
        },
        {
          role: "user",
          content: `Describe in just one relevant short sentence based on this OCR of my screen, what you think I am working on: ${text}`
        }]
      });

      const content = response.content[0].text;

      return content;
    } catch (err) {
      console.error('Error analyzing text:', err);
      throw err;
    }
  };

  const getEventType = (keyword: string): EventType | null => {
    if (keyword.includes('0')) return 'wake';
    if (keyword.includes('1')) return 'query';
    return null;
  };

  const processNewKeyword = async (keyword: string) => {
    const type = getEventType(keyword);

    if (type === 'wake') {
      try {
        const speechPromise = listenForSpeech();

        setTimeout(() => {
          if (readyAudio.current) {
            readyAudio.current.play();
          }
        }, 100);

        const speech = await speechPromise;
        const newEvent: IEvent = {
          timestamp: new Date().toISOString(),
          data: {
            speaker: 'User',
            text: speech
          }
        };
        setEvents(prev => [newEvent, ...prev.slice(0, 5)]);

        const response = await generateResponse(newEvent);
      } catch (err) {
        console.error('Error processing wake command:', err);
        setError(err.toString());
      }
    } else if (type === 'query') {
      await handleConsentFlow();
    }
  };

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isListening && !waitingForConsent) {
      interval = setInterval(async () => {
        try {
          const keyword: string = await invoke('get_last_keyword');
          if (keyword) {
            const keyword_type = getEventType(keyword);
            await processNewKeyword(keyword);
          }
        } catch (err) {
          console.error('Error checking keyword:', err);
          setError(err.toString());
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isListening, events]);

  const renderEvent = (event: IEvent) => {
    return (
      <Flex direction="column" gap="md">
        {event.data.speaker === 'Ivee' && (
          <Flex pb={'xs'} mb={-4} justify={"center"} align={"center"} style={{ borderBottom: `0.5px solid #555555` }}>
            <Image src="./ivee.png" alt="IVEE Logo" h={20} fit="contain" />
          </Flex>
        )}

        {event.data.screenshot?.image && (
          <Flex
            direction="column"
            style={{ flex: 1 }}
          >
            <Text mb={5} size="xs" c="dimmed">Screenshot:</Text>
            <Paper p="xs" shadow='none'>
              <Image
                src={event.data.screenshot?.image}
                alt="Screenshot"
                fit="contain"
                style={{ maxHeight: '300px' }}
              />
            </Paper>
          </Flex>
        )}

        {event.data?.text && (
          <Text>
            {event.data?.text}
          </Text>
        )}
      </Flex>
    );
  };

  return (
    <Flex w={"100%"} direction={"column"} h={'100%'} style={{ overflow: 'hidden' }}>
      <Flex
        flex={1}
        direction={"column"}
        h={'90vh'}
        mah={'90vh'}
        w={"100%"}
        style={{ overflow: 'scroll', scrollbarWidth: 'none', msOverflowStyle: 'none', borderBottom: `1px solid #555555` }}
        ref={scrollRef}
        p={'md'}
        pb={'md'}
        pt={'md'}
      >
        <style>
          {`
        ::-webkit-scrollbar {
          display: none;
        }
          `}
        </style>

        <Flex w={"100%"} flex={1} align={"flex-end"}>
          {events.length > 0 && (
            <Paper w={"100%"}>
              <Stack>
                {events.slice().reverse().map((event) => (
                  <Paper
                    key={event.timestamp}
                    p="xs"
                    shadow='md'
                    withBorder
                    style={{ borderColor: '#404040' }}
                  >
                    <Flex pl={6} pr={6}>
                      {renderEvent(event)}
                    </Flex>
                    <Text pl={6} mt={6} mb={-2} size="xs" c="dimmed">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </Text>
                  </Paper>
                ))}
              </Stack>
            </Paper>
          )}
        </Flex>
      </Flex>

      <Flex mih={60} mt={'md'} p={'md'} pt={0} justify={"center"} style={{ overflow: 'hidden' }}>
        <Button
          onClick={isListening ? handleStopListening : handleStartListening}
          variant={'outline'}
          mih={60}
          color={"white"}
          radius="md"
          w={"100%"}
          style={{ borderColor: '#404040' }}
        >
          {isListening ? <CiMicrophoneOff size={30} style={{ filter: 'drop-shadow(0px 4px 6px black)' }} /> : <CiMicrophoneOn size={30} style={{ filter: 'drop-shadow(0px 4px 6px black)' }} />}
        </Button>
      </Flex>
    </Flex>
  );
};

export default KeywordDetection;
