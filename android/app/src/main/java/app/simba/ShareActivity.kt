package com.operator.simba

import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

/**
 * The capture surface.
 *
 * This is what makes Simba reachable from inside every other app on the phone.
 * Share a link, a reel, a highlighted paragraph or a screenshot caption, and it
 * lands in the intake queue without switching apps or copy-pasting — the
 * friction that otherwise turns "I'll deal with this later" into never.
 *
 * Deliberately a thin sheet with one optional note field. Anything heavier and
 * capture stops being instant, which defeats the point.
 */
class ShareActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val shared = extractShared(intent)
        if (shared.isNullOrBlank()) {
            Toast.makeText(this, "Nothing to capture", Toast.LENGTH_SHORT).show()
            finish()
            return
        }

        setContent { SimbaThemeHost { CaptureSheet(shared) } }
    }

    private fun extractShared(intent: Intent?): String? {
        if (intent == null) return null
        return when (intent.action) {
            Intent.ACTION_SEND -> {
                val text = intent.getStringExtra(Intent.EXTRA_TEXT)
                val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)
                val stream = intent.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM)
                listOfNotNull(
                    subject?.takeIf { it.isNotBlank() },
                    text?.takeIf { it.isNotBlank() },
                    // An image share carries no text; the URI at least records
                    // that something was captured and from where.
                    stream?.let { "[attachment] $it" },
                ).joinToString("\n").ifBlank { null }
            }
            Intent.ACTION_PROCESS_TEXT ->
                intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
            else -> null
        }
    }

    @Composable
    private fun CaptureSheet(shared: String) {
        val scope = rememberCoroutineScope()
        var note by remember { mutableStateOf("") }
        var sending by remember { mutableStateOf(false) }
        var failure by remember { mutableStateOf<String?>(null) }

        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(
                Modifier
                    .padding(18.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(Panel)
                    .padding(18.dp),
            ) {
                Text("Capture to Simba", color = Accent, fontWeight = FontWeight.Bold, fontSize = 16.sp)

                Spacer(Modifier.height(10.dp))
                Box(
                    Modifier
                        .clip(RoundedCornerShape(9.dp))
                        .background(Panel2)
                        .padding(11.dp),
                ) {
                    Text(shared.take(320), color = Dim, fontSize = 12.5.sp, maxLines = 6)
                }

                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text("What should Simba do with this? (optional)", fontSize = 11.5.sp) },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = Accent,
                        unfocusedBorderColor = Line,
                        focusedTextColor = Fg,
                        unfocusedTextColor = Fg,
                    ),
                )

                failure?.let {
                    Text(it.take(140), color = Err, fontSize = 11.5.sp, modifier = Modifier.padding(top = 8.dp))
                }

                Spacer(Modifier.height(14.dp))
                Row(horizontalArrangement = Arrangement.End, modifier = Modifier.fillMaxWidth()) {
                    TextButton(onClick = { finish() }, enabled = !sending) {
                        Text("Cancel", color = Dim)
                    }
                    Spacer(Modifier.width(6.dp))
                    Button(
                        enabled = !sending,
                        onClick = {
                            scope.launch {
                                sending = true
                                failure = null
                                val api = api()
                                val payload =
                                    if (note.isBlank()) shared else "$shared\n\n---\n$note"
                                runCatching { api.capture(payload, "android-share") }
                                    .onSuccess {
                                        Toast.makeText(
                                            this@ShareActivity,
                                            "Captured",
                                            Toast.LENGTH_SHORT,
                                        ).show()
                                        finish()
                                    }
                                    .onFailure {
                                        // Kept on screen rather than dismissed:
                                        // a capture that silently failed is
                                        // worse than one that never happened.
                                        failure = it.message ?: "could not reach Simba"
                                        sending = false
                                    }
                            }
                        },
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Accent,
                            contentColor = OnAccent,
                        ),
                    ) { Text(if (sending) "Sending…" else "Capture", fontWeight = FontWeight.SemiBold) }
                }
            }
        }
    }
}
