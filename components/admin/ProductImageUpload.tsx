"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { FiImage, FiUpload, FiX } from "react-icons/fi";
import toast from "react-hot-toast";
import {
    ActionIcon,
    Box,
    Group,
    Loader,
    Paper,
    SegmentedControl,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";

type Props = {
    value: string;
    onChange: (value: string) => void;
};

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: the `POST /api/admin/upload` multipart call (same `FormData` key `file`, same
 * endpoint, same response parsing), the `data.url` hand-off via `onChange`, the `uploading` gate,
 * the `inputRef.value = ""` reset in `finally` and inside `removeImage()`, the `urlInput` mirror of
 * `value`, the two modes and their default, and every toast/error message.
 *
 * The file picker stays a native `<input type="file">` — hidden and triggered by a `<label>`, which
 * is the accessible way to open a picker without a clickable `div`. `SegmentedControl` replaces the
 * two hand-styled toggle buttons so mode selection reads like the rest of the dashboard.
 */
export default function ProductImageUpload({ value, onChange }: Props) {
    const inputRef = useRef<HTMLInputElement>(null);

    const [uploading, setUploading] = useState(false);
    const [mode, setMode] = useState<"upload" | "url">("upload");
    const [urlInput, setUrlInput] = useState(value);

    async function handleUpload(event: React.ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];

        if (!file) {
            return;
        }

        try {
            setUploading(true);

            const formData = new FormData();

            formData.append("file", file);

            const response = await fetch("/api/admin/upload", {
                method: "POST",
                body: formData,
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || "Upload gagal");
            }

            onChange(data.url);
        } catch (error) {
            console.error(error);

            toast.error(error instanceof Error ? error.message : "Upload gagal");
        } finally {
            setUploading(false);

            if (inputRef.current) {
                inputRef.current.value = "";
            }
        }
    }

    function handleUrlChange(next: string) {
        setUrlInput(next);

        onChange(next);
    }

    function removeImage() {
        setUrlInput("");

        onChange("");

        if (inputRef.current) {
            inputRef.current.value = "";
        }
    }

    return (
        <Stack gap="md">
            <SegmentedControl
                size="md"
                radius="md"
                value={mode}
                onChange={(next) => setMode(next as "upload" | "url")}
                data={[
                    { label: "Upload", value: "upload" },
                    { label: "URL", value: "url" },
                ]}
                w={{ base: "100%", xs: 240 }}
            />

            {mode === "upload" && (
                <Box>
                    <input
                        ref={inputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={handleUpload}
                        hidden
                        id="product-image"
                    />

                    <Paper
                        component="label"
                        htmlFor="product-image"
                        withBorder
                        radius="md"
                        p="xl"
                        style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            minHeight: 176,
                            textAlign: "center",
                            cursor: "pointer",
                            borderStyle: "dashed",
                            borderWidth: 2,
                        }}
                    >
                        {uploading ? (
                            <>
                                <Loader size="md" mb="sm" />

                                <Text size="sm" fw={500}>
                                    Mengupload...
                                </Text>
                            </>
                        ) : (
                            <>
                                <FiUpload size={26} style={{ marginBottom: 10 }} />

                                <Text size="sm" fw={600}>
                                    Upload gambar produk
                                </Text>

                                <Text size="xs" c="dimmed" mt={4}>
                                    JPG, PNG, WEBP • maksimal 5MB
                                </Text>
                            </>
                        )}
                    </Paper>
                </Box>
            )}

            {mode === "url" && (
                <TextInput
                    size="md"
                    radius="md"
                    value={urlInput}
                    onChange={(event) => handleUrlChange(event.currentTarget.value)}
                    placeholder="https://example.com/product.jpg"
                    aria-label="URL gambar produk"
                    leftSection={<FiImage size={16} />}
                />
            )}

            {value && (
                <Paper withBorder radius="md" style={{ position: "relative", overflow: "hidden" }}>
                    <Box style={{ position: "relative", width: "100%", aspectRatio: "16 / 9" }}>
                        <Image
                            src={value}
                            alt="Preview produk"
                            fill
                            style={{ objectFit: "contain" }}
                            unoptimized
                        />
                    </Box>

                    <Group style={{ position: "absolute", top: 12, right: 12 }}>
                        <ActionIcon
                            variant="white"
                            color="ink"
                            size="lg"
                            radius="xl"
                            onClick={removeImage}
                            aria-label="Hapus gambar"
                        >
                            <FiX size={18} />
                        </ActionIcon>
                    </Group>
                </Paper>
            )}
        </Stack>
    );
}
