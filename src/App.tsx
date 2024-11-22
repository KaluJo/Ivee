import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import KeywordDetection from "./components/KeywordDetection";
import {
  AppShell,
  Title,
  Container,
  TextInput,
  Button,
  Text,
  Paper,
  Stack,
  Group,
  useMantineTheme,
  Box,
  Card,
  Image,
  Flex,
} from "@mantine/core";
import { Mic, ScreenShareIcon, MessageCircle } from "lucide-react";
import ScreenshotOCRViewer from "./components/ScreenshotOCRViewer";

export default function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");
  const [ocrText, setOcrText] = useState("");
  const theme = useMantineTheme();
  const [imageData, setImageData] = useState(null);

  async function greet() {
    setGreetMsg(await invoke("greet", { name }));
  }

  return (
    <AppShell>
      <Flex h={"100vh"} style={{ overflow: 'hidden' }} direction={"column"}>
        <Flex pt={0} h={"100vh"} mah={"100vh"} justify={'center'}>
          <KeywordDetection />
        </Flex>
      </Flex>
    </AppShell>
  );
}
